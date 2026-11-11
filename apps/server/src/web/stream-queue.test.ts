/**
 * C-117: the run queue has no seq, so every SSE connection opens with the
 * queue's revision and every change carries the new one. A client that
 * reconnects after a restart compares revisions instead of re-reading every
 * view.
 */
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { type WebHarness, webHarness } from "../../test-support/web.js";
import { project_id, seedWebProject } from "../../test-support/web-data.js";

const queue = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock(import("@cardigan/host"), async (original) => ({
  ...(await original()),
  readRunQueue: (() => queue.rows) as never,
}));

const PASSWORD = "correct horse battery";
let harness: WebHarness;
let cookie: string;

beforeEach(async () => {
  queue.rows = [];
  harness = await webHarness({
    password: PASSWORD,
    stream: { pollMs: 10, heartbeatMs: 60_000 },
  });
  seedWebProject(harness.store, harness.dataDir);
  cookie = await harness.login(PASSWORD);
});
afterEach(async () => {
  await harness.close();
});

/** Open the stream and hand out its `queue` revisions as they arrive. */
function openQueue(): Promise<{
  next(): Promise<string>;
  close(): void;
}> {
  return new Promise((resolve, reject) => {
    const revisions: string[] = [];
    const waiting: ((revision: string) => void)[] = [];
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
            if (frame.startsWith("event: queue\n")) {
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
          close: () => req.destroy(),
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const row = (project: string, ahead: number) => ({
  project_id: project,
  run_id: `R-${project}`,
  ahead,
});

test("each connection opens with the queue revision; a change carries a new one", async () => {
  const first = await openQueue();
  const initial = await first.next();
  expect(initial).toMatch(/^[0-9a-f]{16}$/u);

  // Another project's row does not belong to this project's revision.
  queue.rows = [row("p-other", 0)];
  const other = await openQueue();
  expect(await other.next()).toBe(initial);
  other.close();

  // The project's own row changes it (e.g. its `ahead` count moved).
  queue.rows = [row("p-other", 0), row(project_id, 1)];
  const changed = await first.next();
  expect(changed).not.toBe(initial);
  queue.rows = [row(project_id, 0)];
  const moved = await first.next();
  expect(moved).not.toBe(changed);
  first.close();

  // A reconnect learns the current revision at once, with no event replay.
  const second = await openQueue();
  expect(await second.next()).toBe(moved);
  second.close();

  // Changes while no client was connected show up as a different revision.
  queue.rows = [row(project_id, 3)];
  const third = await openQueue();
  expect(await third.next()).not.toBe(moved);
  third.close();
});
