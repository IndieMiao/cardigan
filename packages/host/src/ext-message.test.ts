import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Decision,
  EXT_MESSAGE_DEFAULTS,
  type ExtMessage,
  type ExtMessagePort,
  extMessageItems,
  type HumanAction,
  notices,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  claimExtMessage,
  listExtMessages,
  projectExtMessage,
  Store,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { card, project_id } from "../../store/src/test-support.js";
import { ExtMessageSender, sendExtMessage } from "./ext-message.js";
import type { ExtMessageConfig } from "./ext-message-config.js";

let dir: string;
let store: Store;
let now: string;
let config: ExtMessageConfig;
const action: HumanAction = {
  id: "H-1",
  key: "H-1",
  card_id: "C-1",
  requested_by: "human",
  instructions: "PRIVATE body",
  why_human: "PRIVATE reason",
  expected_return: "PRIVATE expected",
  blocked_work_items: [],
  status: "open",
};
class FakeAdapter implements ExtMessagePort {
  messages: ExtMessage[] = [];
  result: "sent" | "retryable" | "permanent" = "sent";
  async send(message: ExtMessage) {
    this.messages.push(message);
    return this.result;
  }
}
let fake: FakeAdapter;
const clock = { now: () => now };
const sender = (
  overrides: Partial<ConstructorParameters<typeof ExtMessageSender>[0]> = {},
) =>
  new ExtMessageSender({
    store,
    configuration: { status: "loaded", config },
    clock,
    adapters: { fake: () => fake },
    ...overrides,
  });
const rows = () => listExtMessages(store.database);
const events = () =>
  store.uow.read((tx) => loadCommandState(tx, project_id).events);
const advance = (ms: number) => {
  now = new Date(Date.parse(now) + ms).toISOString();
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ext-sender-"));
  store = Store.open({ dataDir: dir });
  store.createProject({ id: project_id, name: "Fictional" });
  now = "2026-01-01T00:00:00.000Z";
  config = {
    enabled: true,
    workbench_url: "https://workbench.invalid",
    policy: EXT_MESSAGE_DEFAULTS,
    channels: { fake: { enabled: true, credential: "SYNTHETIC_SECRET" } },
  };
  fake = new FakeAdapter();
  store.uow.run((tx) => {
    tx.cards.put(project_id, card());
    tx.human_actions.put(project_id, action);
    tx.events.append(project_id, {
      id: tx.ids.nextEventId(),
      card_id: "C-1",
      seq: tx.ids.nextEventSequence(project_id, "C-1"),
      type: "human_action_requested",
      actor: { kind: "human", project_id },
      payload: { human_action_id: "H-1" },
      created_at: now,
    });
  });
});
afterEach(() => {
  vi.useRealTimers();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
test("success is audited, deduplicated across restart, and disabled config leaves no outbox", async () => {
  await sender({ configuration: { status: "missing" } }).tick();
  await sender({ configuration: { status: "invalid" } }).tick();
  await sender({
    configuration: { status: "loaded", config: { ...config, enabled: false } },
  }).tick();
  expect(rows()).toEqual([]);
  const first = sender();
  first.recordStatus();
  await first.tick();
  expect(rows()).toMatchObject([{ status: "sent", attempts: 1 }]);
  expect(events().filter((e) => e.type === "ext_message_sent")).toHaveLength(1);
  store.close();
  store = Store.open({ dataDir: dir });
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
  const persisted = JSON.stringify([
    rows(),
    events(),
    store.database.prepare("SELECT doc FROM ext_message_host_status").all(),
  ]);
  expect(persisted).not.toContain("SYNTHETIC_SECRET");
  expect(persisted).not.toContain("https://");
  expect(persisted).not.toContain("PRIVATE");
});
test("retry at 30 and 60 seconds, three attempts total, one final notice with no recursion", async () => {
  fake.result = "retryable";
  await sender().tick();
  expect(rows()).toMatchObject([
    {
      status: "pending",
      attempts: 1,
      next_attempt_at: "2026-01-01T00:00:30.000Z",
    },
  ]);
  advance(29999);
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
  advance(1);
  await sender().tick();
  expect(rows()[0]?.attempts).toBe(2);
  advance(59999);
  await sender().tick();
  expect(fake.messages).toHaveLength(2);
  advance(1);
  await sender().tick();
  expect(rows()).toMatchObject([{ status: "failed", attempts: 3 }]);
  advance(60000);
  await sender().tick();
  expect(fake.messages).toHaveLength(3);
  expect(
    store.uow.read((tx) => notices(loadCommandState(tx, project_id))),
  ).toHaveLength(1);
  expect(events().filter((e) => e.type === "ext_message_failed")).toHaveLength(
    3,
  );
});
test("permanent errors stop immediately; raw thrown errors are reduced to unknown", async () => {
  fake.result = "permanent";
  await sender().tick();
  advance(100000);
  await sender().tick();
  expect(rows()).toMatchObject([
    { status: "failed", attempts: 1, last_error: "permanent" },
  ]);
  expect(
    await sendExtMessage(
      {
        send: async () => {
          throw new Error("https://secret.invalid/webhook SYNTHETIC_SECRET");
        },
      },
      { title: "test", url: "https://workbench.invalid" },
      100,
    ),
  ).toBe("unknown");
});
test("first enable ignores handled history, but audits an already queued item that was handled", async () => {
  const [prior] = store.uow.read((tx) =>
    extMessageItems(loadCommandState(tx, project_id), project_id),
  );
  store.uow.run((tx) =>
    tx.human_actions.put(project_id, { ...action, status: "done" }),
  );
  await sender().tick();
  expect(rows()).toEqual([]);
  expect(events().some((e) => e.type === "ext_message_skipped")).toBe(false);
  projectExtMessage(store.database, prior!, "fake", now);
  await sender().tick();
  expect(rows()).toMatchObject([{ status: "skipped", attempts: 0 }]);
  expect(fake.messages).toEqual([]);
  expect(events().filter((e) => e.type === "ext_message_skipped")).toHaveLength(
    1,
  );
});
test("sensitive item reaches adapter with only project, generic prompt and link", async () => {
  store.uow.run((tx) => tx.cards.put(project_id, card({ sensitive: true })));
  await sender().tick();
  expect(fake.messages[0]).toEqual({
    project: project_id,
    title: "有 1 条敏感事项待处理",
    url: "https://workbench.invalid/#/p/p-fictional/cards/C-1?at=human-action-H-1",
  });
});
test("crash after reserving an attempt consumes its budget and waits before recovery", async () => {
  store.uow.run((tx) => {
    const item = extMessageItems(
      loadCommandState(tx, project_id),
      project_id,
    )[0]!;
    projectExtMessage(store.database, item, "fake", now);
    claimExtMessage(
      store.database,
      rows()[0]!,
      "crashed",
      now,
      "2026-01-01T00:00:10.000Z",
      "2026-01-01T00:00:40.000Z",
    );
  });
  store.close();
  store = Store.open({ dataDir: dir });
  await sender().tick();
  expect(fake.messages).toHaveLength(0);
  advance(39999);
  await sender().tick();
  expect(fake.messages).toHaveLength(0);
  advance(1);
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
  expect(rows()).toMatchObject([{ status: "sent", attempts: 2 }]);
});
test("third crashed attempt finalizes once with a Workbench notice", async () => {
  store.uow.run((tx) =>
    projectExtMessage(
      store.database,
      extMessageItems(loadCommandState(tx, project_id), project_id)[0]!,
      "fake",
      now,
    ),
  );
  store.database
    .prepare(
      "UPDATE ext_message_outbox SET attempts=3, lease_id='crashed', lease_until=?, next_attempt_at=?",
    )
    .run(now, now);
  await sender().tick();
  await sender().tick();
  expect(rows()).toMatchObject([
    { status: "failed", attempts: 3, last_error: "unknown" },
  ]);
  expect(fake.messages).toHaveLength(0);
  expect(events().filter((e) => e.type === "ext_message_failed")).toHaveLength(
    1,
  );
});
test("timeout aborts, another channel succeeds independently, concurrent senders do not claim twice", async () => {
  vi.useFakeTimers();
  let aborted = false;
  const slow: ExtMessagePort = {
    send: (_m, signal) =>
      new Promise(() => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
      }),
  };
  config = {
    ...config,
    channels: { ...config.channels, second: { enabled: true } },
  };
  const options = { adapters: { fake: () => slow, second: () => fake } };
  const a = sender(options).tick();
  await vi.advanceTimersByTimeAsync(0);
  const b = sender(options).tick();
  await vi.advanceTimersByTimeAsync(0);
  expect(fake.messages).toHaveLength(1);
  expect(rows().find((r) => r.channel === "fake")?.attempts).toBe(1);
  advance(10000);
  await vi.advanceTimersByTimeAsync(10000);
  await Promise.all([a, b]);
  expect(aborted).toBe(true);
  expect(rows().find((r) => r.channel === "fake")).toMatchObject({
    status: "pending",
    attempts: 1,
    last_error: "timeout",
  });
});
test("deferred and quiet items wait, then handled items skip; absent adapter fails safely", async () => {
  store.uow.run((tx) =>
    tx.human_actions.put(project_id, {
      ...action,
      ready_when: { kind: "manual" },
    }),
  );
  await sender().tick();
  expect(fake.messages).toEqual([]);
  store.uow.run((tx) => tx.human_actions.put(project_id, action));
  config = {
    ...config,
    quiet_hours: { timezone: "UTC", start: "23:00", end: "08:00" },
  };
  await sender().tick();
  expect(rows()[0]?.attempts).toBe(0);
  advance(8 * 3600000);
  await sender({ adapters: {} }).tick();
  expect(rows()).toMatchObject([
    { status: "failed", attempts: 1, last_error: "adapter_unavailable" },
  ]);
});

test("remote success followed by local commit failure rolls back audit and recovers within the same budget", async () => {
  store.database.exec(
    `CREATE TRIGGER fail_sent BEFORE INSERT ON events WHEN NEW.type = 'ext_message_sent' BEGIN SELECT RAISE(ABORT, 'simulated commit failure'); END`,
  );
  await expect(sender().tick()).rejects.toThrow("simulated commit failure");
  expect(fake.messages).toHaveLength(1);
  expect(rows()).toMatchObject([{ status: "pending", attempts: 1 }]);
  expect(events().some((e) => e.type === "ext_message_sent")).toBe(false);
  store.database.exec("DROP TRIGGER fail_sent");
  advance(40000);
  await sender().tick();
  expect(fake.messages).toHaveLength(2);
  expect(rows()).toMatchObject([{ status: "sent", attempts: 2 }]);
  expect(events().filter((e) => e.type === "ext_message_sent")).toHaveLength(1);
  expect(events().filter((e) => e.type === "ext_message_failed")).toHaveLength(
    1,
  );
});

test("late result cannot overwrite the successor's result after a lease expires", async () => {
  let resolve: (result: "sent") => void = () => {};
  const old = sender({
    adapters: {
      fake: () => ({
        send: () =>
          new Promise<"sent">((done) => {
            resolve = done;
          }),
      }),
    },
  }).tick();
  await Promise.resolve();
  advance(40000);
  fake.result = "permanent";
  await sender().tick();
  resolve("sent");
  await old;
  expect(rows()).toMatchObject([
    { status: "failed", attempts: 2, last_error: "permanent" },
  ]);
  expect(events().filter((e) => e.type === "ext_message_sent")).toEqual([]);
});

test.each(["sent", "commit_failure", "timeout"] as const)(
  "shutdown drains the second channel (%s) after the first channel cannot commit",
  async (outcome) => {
    vi.useFakeTimers();
    config = {
      ...config,
      channels: { first: { enabled: true }, second: { enabled: true } },
    };
    store.database.exec(`CREATE TRIGGER fail_channel_sent BEFORE INSERT ON events
      WHEN NEW.type = 'ext_message_sent' AND json_extract(NEW.doc, '$.payload.channel') = 'first'
      BEGIN SELECT RAISE(ABORT, 'first result commit failure'); END`);
    if (outcome === "commit_failure")
      store.database.exec(`CREATE TRIGGER fail_second_sent BEFORE INSERT ON events
        WHEN NEW.type = 'ext_message_sent' AND json_extract(NEW.doc, '$.payload.channel') = 'second'
        BEGIN SELECT RAISE(ABORT, 'second result commit failure'); END`);
    const second = Promise.withResolvers<"sent">();
    const active = sender({
      adapters: {
        first: () => fake,
        second: () => ({ send: () => second.promise }),
      },
    });
    let tickSettled = false;
    let stopSettled = false;
    const tickResult = active
      .tick()
      .catch((error: unknown) => error)
      .finally(() => {
        tickSettled = true;
      });
    let stopResult: Promise<unknown> | undefined;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(rows()).toMatchObject([
        { channel: "first", status: "pending", attempts: 1 },
        { channel: "second", status: "pending", attempts: 1 },
      ]);
      expect(fake.messages).toHaveLength(1);
      expect(tickSettled).toBe(false);
      stopResult = active
        .stop()
        .catch((error: unknown) => error)
        .finally(() => {
          stopSettled = true;
        });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopSettled).toBe(false);
      if (outcome === "timeout") {
        advance(10000);
        await vi.advanceTimersByTimeAsync(10000);
      } else {
        second.resolve("sent");
      }
      const [tickError, stopError] = await Promise.all([
        tickResult,
        stopResult,
      ]);
      expect(tickSettled).toBe(true);
      expect(stopSettled).toBe(true);
      expect(stopError).toBe(tickError);
      if (outcome === "commit_failure") {
        expect(tickError).toBeInstanceOf(AggregateError);
        expect(
          (tickError as AggregateError).errors.map((e: Error) => e.message),
        ).toEqual([
          "first result commit failure",
          "second result commit failure",
        ]);
      } else {
        expect(tickError).toMatchObject({
          message: "first result commit failure",
        });
      }
      const secondRow = rows().find((r) => r.channel === "second");
      expect(secondRow).toMatchObject(
        outcome === "sent"
          ? { status: "sent", attempts: 1 }
          : {
              status: "pending",
              attempts: 1,
              last_error: outcome === "timeout" ? "timeout" : null,
            },
      );
      expect(
        events().filter((e) => e.type === "ext_message_sent"),
      ).toHaveLength(outcome === "sent" ? 1 : 0);
      // The caller can now close its Store. A fresh process sees every completed result.
      store.close();
      store = Store.open({ dataDir: dir });
      expect(rows().find((r) => r.channel === "second")).toEqual(secondRow);
    } finally {
      second.resolve("sent");
      await vi.advanceTimersByTimeAsync(0);
      await Promise.all([tickResult, stopResult]);
    }
  },
);

const quiet = () => {
  config = {
    ...config,
    quiet_hours: { timezone: "UTC", start: "23:00", end: "08:00" },
  };
};
const addAction = (n: number) =>
  store.uow.run((tx) => {
    const id = `H-${n}` as HumanAction["id"];
    tx.human_actions.put(project_id, { ...action, id, key: id });
    tx.events.append(project_id, {
      id: tx.ids.nextEventId(),
      card_id: "C-1",
      seq: tx.ids.nextEventSequence(project_id, "C-1"),
      type: "human_action_requested",
      actor: { kind: "human", project_id },
      payload: { human_action_id: id },
      created_at: now,
    });
  });

test("quiet digest survives restart, removes handled items, rechecks sensitivity, and truncates once", async () => {
  quiet();
  for (let n = 2; n <= 23; n++) addAction(n);
  await sender().tick();
  expect(fake.messages).toHaveLength(0);
  expect(
    rows().every((r) => r.attempts === 0 && r.digest_id === "queued"),
  ).toBe(true);
  store.close();
  store = Store.open({ dataDir: dir });
  store.uow.run((tx) => {
    tx.human_actions.put(project_id, { ...action, status: "done" });
    tx.cards.put(project_id, card({ sensitive: true }));
  });
  advance(8 * 3600000);
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
  const digest = fake.messages[0];
  if (!digest) throw new Error("Expected digest");
  expect(digest.title).toBe("免打扰期间 22 条待处理");
  if (!("items" in digest)) throw new Error("Expected digest");
  expect(digest.items).toHaveLength(20);
  expect(
    digest.items.every(
      (i) => i.title === "有 1 条敏感事项待处理" && !("card" in i),
    ),
  ).toBe(true);
  expect(rows().filter((r) => r.status === "sent")).toHaveLength(22);
  expect(rows().find((r) => r.item_id === "H-1")?.status).toBe("skipped");
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
});

test("restart after quiet hours projects unscanned source events into one digest", async () => {
  quiet();
  addAction(2);
  advance(8 * 3600000);
  // Both source events happened while quiet, even though no sender was running then.
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
  expect(fake.messages[0]).toMatchObject({
    total: 2,
    title: "免打扰期间 2 条待处理",
  });
  addAction(3);
  await sender().tick();
  expect(fake.messages).toHaveLength(2);
  expect(fake.messages[1]).not.toHaveProperty("items");
});

test("recovery spanning two projection batches sends one quiet digest and does not hold ordinary messages", async () => {
  quiet();
  // Insert one ordinary item amongst 33 quiet-hour members. None has been projected yet.
  advance(8 * 3600000);
  addAction(2);
  advance(-8 * 3600000);
  for (let n = 3; n <= 34; n++) addAction(n);
  advance(8 * 3600000);
  await sender().tick();
  expect(rows()).toHaveLength(32);
  expect(fake.messages).toHaveLength(1);
  expect(fake.messages[0]).toMatchObject({ item: "H-2" });
  // A new process must recognize the unfinished digest from persisted rows.
  store.close();
  store = Store.open({ dataDir: dir });
  await sender().tick();
  await sender().tick();
  expect(fake.messages).toHaveLength(2);
  const digest = fake.messages[1];
  expect(digest).toMatchObject({ total: 33, title: "免打扰期间 33 条待处理" });
  expect(digest && "items" in digest && digest.items).toHaveLength(20);
  expect(rows().filter((r) => r.status === "sent")).toHaveLength(34);
});

test("digest retries preserve the approved budget and membership across restart and local commit failure", async () => {
  quiet();
  addAction(2);
  await sender().tick();
  advance(8 * 3600000);
  store.database.exec(`CREATE TRIGGER fail_digest BEFORE INSERT ON events WHEN NEW.type = 'ext_message_sent'
    BEGIN SELECT RAISE(ABORT, 'digest commit failure'); END`);
  await expect(sender().tick()).rejects.toThrow("digest commit failure");
  expect(rows().every((r) => r.attempts === 1 && r.status === "pending")).toBe(
    true,
  );
  expect(new Set(rows().map((r) => r.digest_id)).size).toBe(1);
  store.database.exec("DROP TRIGGER fail_digest");
  store.close();
  store = Store.open({ dataDir: dir });
  fake.result = "retryable";
  advance(39999);
  await sender().tick();
  expect(fake.messages).toHaveLength(1);
  advance(1);
  await sender().tick();
  expect(fake.messages).toHaveLength(2);
  advance(59999);
  await sender().tick();
  expect(fake.messages).toHaveLength(2);
  advance(1);
  await sender().tick();
  expect(fake.messages).toHaveLength(3);
  expect(rows().every((r) => r.attempts === 3 && r.status === "failed")).toBe(
    true,
  );
  // One terminal notice per original outbox item, never an external notification of that notice.
  expect(
    store.uow.read((tx) => notices(loadCommandState(tx, project_id))),
  ).toHaveLength(2);
  await sender().tick();
  expect(fake.messages).toHaveLength(3);
  expect(rows()).toHaveLength(2);
});

test("a digest is claimed atomically by concurrent senders and retry drops newly handled members", async () => {
  quiet();
  addAction(2);
  await sender().tick();
  advance(8 * 3600000);
  const response = Promise.withResolvers<"retryable">();
  const send = vi.fn(() => response.promise);
  const first = sender({ adapters: { fake: () => ({ send }) } }).tick();
  await sender({ adapters: { fake: () => ({ send }) } }).tick();
  expect(send).toHaveBeenCalledTimes(1);
  response.resolve("retryable");
  await first;
  store.uow.run((tx) => {
    tx.human_actions.put(project_id, { ...action, status: "done" });
    tx.cards.put(project_id, card({ sensitive: true }));
  });
  advance(30000);
  await sender().tick();
  expect(fake.messages[0]).toMatchObject({
    total: 1,
    items: [{ title: "有 1 条敏感事项待处理" }],
  });
  expect(rows().find((r) => r.item_id === "H-1")).toMatchObject({
    attempts: 1,
    status: "skipped",
  });
  expect(rows().find((r) => r.item_id === "H-2")).toMatchObject({
    attempts: 2,
    status: "sent",
  });
});

test("a concurrent write after projection invalidates the batch; next tick uses fresh sensitivity", async () => {
  const other = Store.open({ dataDir: dir });
  try {
    const active = sender();
    store.observe({
      transaction(kind) {
        if (kind !== "read") return;
        store.observe(undefined);
        other.uow.run((tx) =>
          tx.cards.put(project_id, card({ sensitive: true })),
        );
      },
    });
    await active.tick();
    expect(rows()).toEqual([]);
    await active.tick();
    expect(fake.messages.map((m) => m.title)).toEqual([
      "有 1 条敏感事项待处理",
    ]);
  } finally {
    other.close();
  }
});

test("an external edit during send is not mistaken for our settlement audit", async () => {
  addAction(2);
  const active = sender({
    adapters: {
      fake: () => ({
        async send(m) {
          fake.messages.push(m);
          if (fake.messages.length === 1)
            store.uow.run((tx) =>
              tx.cards.put(project_id, card({ sensitive: true })),
            );
          return "sent";
        },
      }),
    },
  });
  await active.tick();
  expect(fake.messages).toHaveLength(1);
  await active.tick();
  expect(fake.messages[1]?.title).toBe("有 1 条敏感事项待处理");
});

test("production-size first enable bounds tick computation, replay writes and writer lock time", async () => {
  // Keep the creation facts at the end of the stream ordering (a worst-case linear find).
  store.uow.run((tx) => {
    store.database
      .prepare(`WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<150000)
      INSERT INTO events(project_id,id,card_id,stream,seq,type,doc)
      SELECT ?, 'history-'||i, NULL,'',i,'tick', json_object('id','history-'||i,'seq',i,'type','tick','payload',json('{}'),'actor',json_object('kind','system','project_id',?),'created_at',?) FROM n`)
      .run(project_id, project_id, now);
    const fact = (
      payload: { decision_id: string } | { human_action_id: string },
    ) =>
      tx.events.append(project_id, {
        id: tx.ids.nextEventId(),
        card_id: "C-1",
        seq: tx.ids.nextEventSequence(project_id, "C-1"),
        type:
          "decision_id" in payload
            ? "decision_requested"
            : "human_action_requested",
        actor: { kind: "human", project_id },
        created_at: now,
        payload,
      });
    for (let n = 1; n <= 1000; n++) {
      const id = `Q-${n}` as Decision["id"];
      tx.decisions.put(project_id, {
        id,
        key: id,
        card_id: "C-1",
        kind: "choose",
        question: "Fixture",
        context: "",
        raised_by: "human",
        decider: "human",
        status: "open",
        category: "general",
        blocking: false,
        affected_cards: [],
        affected_work_items: [],
        options: [],
        recommended: "",
        doc_refs: [],
      });
      fact({ decision_id: id });
    }
    for (let n = 2; n <= 200; n++) {
      const id = `H-${n}` as HumanAction["id"];
      tx.human_actions.put(project_id, { ...action, id, key: id });
      fact({ human_action_id: id });
    }
  });
  expect(
    store.database.prepare("SELECT COUNT(*) AS n FROM events").get()?.n,
  ).toBe(151200);
  const active = sender();
  // First tick includes cold SQLite/JSON decoding. Second tick sees our audits,
  // so it must reproject (and take the next batch), not hit an unchanged cursor.
  for (const cold of [true, false]) {
    const locks: number[] = [];
    let compute = 0;
    store.observe({
      transaction(kind, ms) {
        if (kind === "run") locks.push(ms);
        else compute += ms;
      },
    });
    const start = performance.now();
    await active.tick();
    const elapsed = performance.now() - start,
      longest = Math.max(...locks);
    console.info(
      `ext-message (${cold ? "cold" : "warm"}): projection ${compute.toFixed(1)} ms, tick ${elapsed.toFixed(1)} ms, longest write ${longest.toFixed(1)} ms`,
    );
    expect(rows()).toHaveLength(cold ? 32 : 64);
    expect(fake.messages).toHaveLength(cold ? 32 : 64);
    expect(compute).toBeLessThan(cold ? 2000 : 200);
    expect(elapsed).toBeLessThan(cold ? 3000 : 750);
    expect(longest).toBeLessThan(50);
  }
}, 20000);
