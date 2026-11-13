/**
 * C-232: the host's in-memory context samples have no seq and no event, so
 * every SSE connection opens with their revision and every change (first
 * sample, new reading, unknown or expired sample) carries a new one. Without
 * it an open execution view would keep "—" or an old reading.
 */
import { request as httpRequest } from "node:http";
import type { ContextObservation } from "@cardigan/domain";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type WebHarness, webHarness } from "../../test-support/web.js";
import {
  NOW,
  project_id,
  seedWebProject,
} from "../../test-support/web-data.js";

const PASSWORD = "correct horse battery";
let harness: WebHarness;
let cookie: string;
let samples = new Map<string, ContextObservation>();

beforeEach(async () => {
  samples = new Map();
  harness = await webHarness({
    password: PASSWORD,
    stream: { pollMs: 10, heartbeatMs: 60_000 },
    contextUsage: () => samples,
  });
  seedWebProject(harness.store, harness.dataDir);
  cookie = await harness.login(PASSWORD);
});
afterEach(async () => {
  await harness.close();
});

/** Open the stream; hand out `context` revisions and count `change` frames. */
function openStream(): Promise<{
  next(): Promise<string>;
  changes(): number;
  close(): void;
}> {
  return new Promise((resolve, reject) => {
    const revisions: string[] = [];
    const waiting: ((revision: string) => void)[] = [];
    let changes = 0;
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: harness.port,
        path: `/api/projects/${project_id}/stream`,
        agent: false,
        headers: { cookie, accept: "text/event-stream" },
      },
      (res) => {
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let index = buffer.indexOf("\n\n");
          while (index >= 0) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            if (frame.startsWith("event: change\n")) changes += 1;
            if (frame.startsWith("event: context\n")) {
              const data = JSON.parse(
                frame.slice(frame.indexOf("data: ") + 6),
              ) as { revision: string };
              const resolveNext = waiting.shift();
              if (resolveNext) resolveNext(data.revision);
              else revisions.push(data.revision);
            }
            index = buffer.indexOf("\n\n");
          }
        });
        resolve({
          next: () => {
            const ready = revisions.shift();
            return ready !== undefined
              ? Promise.resolve(ready)
              : new Promise((done) => waiting.push(done));
          },
          changes: () => changes,
          close: () => req.destroy(),
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const sample = (tokens: number, updated_at = NOW): ContextObservation => ({
  agent: "codex",
  session_id: "s-1",
  transcript_path: null,
  cwd: "/srv/agent/worktrees/A-1",
  model: "fixture-model",
  context_tokens: tokens,
  context_window_size: 1000,
  used_percentage: tokens / 10,
  updated_at,
  assignment_id: "A-1" as never,
  runtime_key: "null",
  source: "codex_rollout:last_token_usage",
});

test("C-232: first sample, a new reading and expiry each push a context revision without any event", async () => {
  const stream = await openStream();
  const empty = await stream.next();
  expect(empty).toMatch(/^[0-9a-f]{16}$/u);

  samples = new Map([["A-1", sample(420)]]);
  const first = await stream.next();
  expect(first).not.toBe(empty);

  samples = new Map([["A-1", sample(650, "2026-01-01T00:00:31.000Z")]]);
  const changed = await stream.next();
  expect(changed).not.toBe(first);

  // The host drops an expired or unknown sample; the view must clear it.
  samples = new Map();
  expect(await stream.next()).toBe(empty);
  // None of this is a business event: no change frame was sent.
  expect(stream.changes()).toBe(0);
  stream.close();

  // A reconnect learns the current revision at once.
  samples = new Map([["A-1", sample(650, "2026-01-01T00:00:31.000Z")]]);
  const again = await openStream();
  expect(await again.next()).toBe(changed);
  again.close();
});

test("C-232: without a dispatcher there is no context frame", async () => {
  const plain = await webHarness({
    password: PASSWORD,
    stream: { pollMs: 10, heartbeatMs: 60_000 },
  });
  try {
    seedWebProject(plain.store, plain.dataDir);
    const plainCookie = await plain.login(PASSWORD);
    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: plain.port,
          path: `/api/projects/${project_id}/stream`,
          agent: false,
          headers: { cookie: plainCookie, accept: "text/event-stream" },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            text += chunk;
            // The context frame would follow the queue frame at once; give
            // the 10ms poll a few rounds as well.
            if (text.includes("event: queue\n"))
              setTimeout(() => {
                req.destroy();
                resolve(text);
              }, 100);
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(body).not.toContain("event: context");
  } finally {
    await plain.close();
  }
});
