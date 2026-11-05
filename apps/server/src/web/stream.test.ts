/**
 * M5.1 real-time refresh (plan phase-1-m5 §3.3).
 *
 * The stream sends per-stream seqs, replays what a reconnecting client missed
 * and never acknowledges on the client's behalf: an idle browser must not make
 * an Agent's bell look delivered.
 */
import { request as httpRequest } from "node:http";
import { expect, test } from "vitest";
import { webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";
import { parseAfter } from "./stream.js";

const PASSWORD = "correct horse battery";

interface Streamed {
  readonly events: {
    stream: string;
    seq: number;
    type: string;
    card_id: string | null;
  }[];
  readonly heartbeats: number;
  close(): void;
}

/** Open the SSE endpoint and collect `change` events until `close()`. */
function openStream(
  port: number,
  query: string,
  cookie: string,
): Promise<Streamed> {
  return new Promise((resolve, reject) => {
    const events: Streamed["events"] = [];
    let heartbeats = 0;
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: `/api/projects/${project_id}/stream${query}`,
        headers: { cookie, accept: "text/event-stream" },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`stream answered ${res.statusCode}`));
          return;
        }
        expect(String(res.headers["content-type"])).toContain(
          "text/event-stream",
        );
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let index = buffer.indexOf("\n\n");
          while (index >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (frame.startsWith(":")) {
              heartbeats += 1;
            } else if (frame.startsWith("event: change")) {
              const data = frame
                .split("\n")
                .find((line) => line.startsWith("data: "));
              if (data !== undefined) {
                events.push(JSON.parse(data.slice("data: ".length)));
              }
            }
            index = buffer.indexOf("\n\n");
          }
        });
        resolve({
          events,
          get heartbeats() {
            return heartbeats;
          },
          close: () => {
            req.destroy();
            res.destroy();
          },
        } as Streamed);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Append one event the way a command would (§6.1 step 4). */
function appendEvent(
  harness: Awaited<ReturnType<typeof webHarness>>,
  card_id: string | undefined,
  type: string,
) {
  harness.store.uow.run((tx) => {
    const seq = tx.ids.nextEventSequence(
      project_id,
      card_id as never | undefined,
    );
    tx.events.append(project_id, {
      id: tx.ids.nextEventId(),
      ...(card_id === undefined ? {} : { card_id: card_id as never }),
      seq,
      type,
      actor: { kind: "human", project_id },
      payload: {},
      created_at: new Date().toISOString(),
    });
  });
}

test("a fresh connection replays nothing and then pushes new seqs", async () => {
  const harness = await webHarness({
    password: PASSWORD,
    stream: { pollMs: 20, heartbeatMs: 20 },
  });
  try {
    seedWebProject(harness.store, harness.dataDir);
    const cookie = await harness.login(PASSWORD);
    const stream = await openStream(harness.port, "", cookie);
    try {
      await wait(60);
      expect(stream.events).toEqual([]);

      appendEvent(harness, "C-1", "comment_added");
      await wait(120);
      expect(stream.events).toHaveLength(1);
      expect(stream.events[0]).toMatchObject({
        stream: "C-1",
        type: "comment_added",
        card_id: "C-1",
      });
      // Seq 3 continues C-1's own stream (two fixture events came before).
      expect(stream.events[0]?.seq).toBe(3);

      appendEvent(harness, undefined, "project_updated");
      await wait(120);
      expect(stream.events.at(-1)).toMatchObject({
        stream: "project",
        type: "project_updated",
        card_id: null,
      });
      expect(
        stream.events.filter((event) => event.type === "project_updated"),
      ).toHaveLength(1);
    } finally {
      stream.close();
    }
  } finally {
    await harness.close();
  }
});

test("a reconnect replays the seqs the client missed, without duplicates", async () => {
  const harness = await webHarness({
    password: PASSWORD,
    stream: { pollMs: 20, heartbeatMs: 20 },
  });
  try {
    seedWebProject(harness.store, harness.dataDir);
    const cookie = await harness.login(PASSWORD);

    // The client saw every stream up to its first event except C-1's second.
    const stream = await openStream(
      harness.port,
      "?after=project:1,C-1:1,C-2:1",
      cookie,
    );
    try {
      await wait(80);
      expect(
        stream.events.map((event) => `${event.stream}:${event.seq}`),
      ).toEqual(["C-1:2"]);
      // A second poll must not repeat what it already sent.
      await wait(80);
      expect(stream.events).toHaveLength(1);
    } finally {
      stream.close();
    }

    // Asking for every stream from zero replays the history exactly once.
    const fromZero = await openStream(
      harness.port,
      "?after=project:0,C-1:0,C-2:0",
      cookie,
    );
    try {
      await wait(80);
      const keys = fromZero.events.map(
        (event) => `${event.stream}:${event.seq}`,
      );
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).toEqual(
        expect.arrayContaining(["C-1:1", "C-1:2", "C-2:1", "project:1"]),
      );
    } finally {
      fromZero.close();
    }
  } finally {
    await harness.close();
  }
});

test("a heartbeat keeps an idle stream alive", async () => {
  const harness = await webHarness({
    password: PASSWORD,
    stream: { pollMs: 20, heartbeatMs: 20 },
  });
  try {
    seedWebProject(harness.store, harness.dataDir);
    const cookie = await harness.login(PASSWORD);
    const stream = await openStream(
      harness.port,
      "?after=project:1,C-1:2,C-2:1",
      cookie,
    );
    try {
      await wait(120);
      expect(stream.events).toEqual([]);
      expect(stream.heartbeats).toBeGreaterThan(0);
    } finally {
      stream.close();
    }
  } finally {
    await harness.close();
  }
});

test("the stream never advances an Agent cursor", async () => {
  const harness = await webHarness({
    password: PASSWORD,
    stream: { pollMs: 20, heartbeatMs: 20 },
  });
  try {
    seedWebProject(harness.store, harness.dataDir);
    const cookie = await harness.login(PASSWORD);
    const before = harness.store.uow.read((tx) => tx.cursors.list(project_id));
    const stream = await openStream(harness.port, "", cookie);
    try {
      appendEvent(harness, "C-2", "delivery_submitted");
      await wait(120);
      expect(stream.events).toHaveLength(1);
    } finally {
      stream.close();
    }
    expect(harness.store.uow.read((tx) => tx.cursors.list(project_id))).toEqual(
      before,
    );
  } finally {
    await harness.close();
  }
});

test("a malformed cursor is a 400, not a silent reset", async () => {
  const harness = await webHarness({ password: PASSWORD });
  try {
    seedWebProject(harness.store, harness.dataDir);
    const cookie = await harness.login(PASSWORD);
    const res = await fetch(
      `http://127.0.0.1:${harness.port}/api/projects/${project_id}/stream?after=C-1`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
  } finally {
    await harness.close();
  }
});

test("the cursor parser accepts the plan's format", () => {
  expect(parseAfter(null)).toEqual([]);
  expect(parseAfter("project:12,C-1:8")).toEqual([
    { stream: "", seq: 12 },
    { stream: "C-1", seq: 8 },
  ]);
  expect(() => parseAfter("C-1")).toThrow(/malformed/u);
  expect(() => parseAfter("C-1:-2")).toThrow(/malformed/u);
});
