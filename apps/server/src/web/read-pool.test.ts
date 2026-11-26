/**
 * C-644: the Workbench's heavy reads run in read workers with a queue limit and
 * a timeout, and the Web thread (shared with MCP) never builds command state
 * for them.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CardId, CommandState, ProjectId } from "@cardigan/domain";
import { afterEach, expect, test, vi } from "vitest";
import { call, webHarness } from "../../test-support/web.js";
import {
  NOW,
  project_id,
  seedWebProject,
} from "../../test-support/web-data.js";
import { HttpRejection } from "./http.js";
import {
  hostFactMachines,
  runWorkbenchRead,
  type WorkbenchReadOp,
} from "./read-ops.js";
import {
  laneFor,
  WORKBENCH_READ_DEFAULTS,
  WorkbenchReadPool,
  workbenchReadOptionsFromEnv,
} from "./read-pool.js";

const PASSWORD = "correct horse battery";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

/** A scripted worker speaking the pool protocol; no real reads, no CPU spin. */
function stubWorker(): URL {
  const dir = mkdtempSync(join(tmpdir(), "cardigan-read-stub-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "stub.mjs");
  writeFileSync(
    file,
    `import { parentPort, threadId } from "node:worker_threads";
let seen = 0;
const asks = new Map();
const warm = [];
parentPort.on("message", (m) => {
  if (m.kind === "close") { parentPort.close(); return; }
  if (m.kind === "warm") { warm.push(...m.projects); return; }
  if (m.kind === "host") { asks.get(m.id)?.(m.facts); asks.delete(m.id); return; }
  if (m.kind !== "read") return;
  seen++;
  const op = m.op;
  const done = (body) => parentPort.postMessage({ kind: "done", id: m.id, result: { body: JSON.stringify(body), timings: { stub: 1 } } });
  if (op.kind === "hang") return;
  if (op.kind === "crash") process.exit(1);
  if (op.kind === "reject") { parentPort.postMessage({ kind: "done", id: m.id, error: { status: 404, code: "not_found", message: "missing" } }); return; }
  if (op.kind === "throw") { parentPort.postMessage({ kind: "done", id: m.id, error: null }); return; }
  if (op.kind === "host") {
    asks.set(m.id, (facts) => done({ facts }));
    parentPort.postMessage({ kind: "host", id: m.id, request: { project: op.project, machines: ["m1"], purpose: "needs" } });
    return;
  }
  setTimeout(() => done({ seen, threadId, project: op.project, warm }), op.delay ?? 0);
});
`,
  );
  return new URL(`file://${file}`);
}

function pool(options: {
  workers?: number;
  maxQueue?: number;
  timeoutMs?: number;
  warmProjects?: readonly string[];
}) {
  const p = new WorkbenchReadPool({
    dbPath: "/nonexistent/stub.db",
    workerUrl: stubWorker(),
    ...options,
  });
  cleanups.push(() => p.close());
  return p;
}

const op = (kind: string, extra: Record<string, unknown> = {}) =>
  ({ kind, project: "p1", ...extra }) as unknown as WorkbenchReadOp;
const body = (result: { body?: string }) => JSON.parse(result.body ?? "null");
async function rejection(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpRejection);
  return error as HttpRejection;
}

test("the smallest queue still serves an idle worker", async () => {
  const p = pool({ workers: 1, maxQueue: 1 });
  expect(body(await p.read(op("ok"))).project).toBe("p1");
  expect(body(await p.read(op("ok"))).seen).toBe(2);
});

test("a full queue answers 503 read_busy at once with Retry-After", async () => {
  const p = pool({ workers: 1, maxQueue: 1, timeoutMs: 60_000 });
  const running = p.read(op("hang"));
  running.catch(() => undefined);
  await vi.waitFor(() => expect(p.stats().running).toBe(1));
  const queued = p.read(op("ok"));
  queued.catch(() => undefined);
  expect(p.stats()).toMatchObject({ running: 1, queued: 1 });
  const busy = await rejection(p.read(op("ok")));
  expect(busy).toMatchObject({ status: 503, code: "read_busy" });
  expect(busy.headers).toEqual({ "Retry-After": "1" });
  // Other projects in other workers keep their own queues.
  expect(laneFor("p1", 1)).toBe(0);
});

test("a timed-out read answers 503 read_timeout; a queued one is dropped unread, a running one finishes first", async () => {
  const p = pool({ workers: 1, maxQueue: 8, timeoutMs: 100 });
  const slow = p.read(op("slow", { delay: 200 }));
  const queued = p.read(op("ok"));
  slow.catch(() => undefined);
  queued.catch(() => undefined);
  expect(await rejection(slow)).toMatchObject({
    status: 503,
    code: "read_timeout",
  });
  expect(await rejection(queued)).toMatchObject({
    status: 503,
    code: "read_timeout",
  });
  // The running read still holds its worker until it finishes.
  expect(p.stats()).toMatchObject({ running: 1, queued: 0 });
  await vi.waitFor(() => expect(p.stats().running).toBe(0));
  const next = body(await p.read(op("ok")));
  // The worker saw the slow read and this one, never the dropped one.
  expect(next.seen).toBe(2);
});

test("a read stuck past four timeouts restarts its worker so later reads go through", async () => {
  const p = pool({ workers: 1, maxQueue: 8, timeoutMs: 250 });
  const first = body(await p.read(op("ok")));
  const stuck = p.read(op("hang"));
  stuck.catch(() => undefined);
  expect(await rejection(stuck)).toMatchObject({ code: "read_timeout" });
  await vi.waitFor(() => expect(p.stats().running).toBe(0), {
    timeout: 5_000,
  });
  const next = body(await p.read(op("ok")));
  expect(next.threadId).not.toBe(first.threadId);
});

test("a crashed worker answers 503 read_unavailable and the next read gets a fresh worker", async () => {
  const p = pool({ workers: 1 });
  const first = body(await p.read(op("ok")));
  expect(await rejection(p.read(op("crash")))).toMatchObject({
    status: 503,
    code: "read_unavailable",
  });
  const next = body(await p.read(op("ok")));
  expect(next.threadId).not.toBe(first.threadId);
  expect(next.seen).toBe(1);
});

test("worker rejections keep their HTTP status; unknown failures stay internal", async () => {
  const p = pool({ workers: 1 });
  expect(await rejection(p.read(op("reject")))).toMatchObject({
    status: 404,
    code: "not_found",
    message: "missing",
  });
  const error = await p.read(op("throw")).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(HttpRejection);
});

test("an op that cannot be cloned fails alone and frees its worker", async () => {
  const p = pool({ workers: 1 });
  const error = await p.read(op("ok", { parse: () => 1 })).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect(p.stats()).toMatchObject({ running: 0, queued: 0 });
  expect(body(await p.read(op("ok"))).project).toBe("p1");
});

test("a project always reads in the same worker; timings come back with the queue wait", async () => {
  const p = pool({ workers: 4 });
  const timings: Record<string, number> = {};
  const a = body(
    await p.read(op("ok"), undefined, (stage, ms) => {
      timings[stage] = ms;
    }),
  );
  const b = body(await p.read(op("ok")));
  expect(b.threadId).toBe(a.threadId);
  expect(b.seen).toBe(2);
  expect(Object.keys(timings).sort()).toEqual(["read_queue", "stub"]);
  for (const project of ["cardigan", "sensen", "p-web"])
    expect(laneFor(project, 4)).toBe(laneFor(project, 4));
  expect(
    new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((x) => laneFor(x, 4)))
      .size,
  ).toBeGreaterThan(1);
});

test("C-774: two active projects never share a worker at workers=2, even when their ids hash alike", async () => {
  // Before C-774 the hash put this production pair on the same worker.
  expect(laneFor("cardigan", 2)).toBe(laneFor("sensen-godot", 2));
  const p = pool({ workers: 2 });
  const a = body(await p.read(op("ok", { project: "cardigan" })));
  const b = body(await p.read(op("ok", { project: "sensen-godot" })));
  expect(b.threadId).not.toBe(a.threadId);
  expect(p.laneOf("cardigan")).not.toBe(p.laneOf("sensen-godot"));
  expect(p.stats().projects.map((ids) => ids.length)).toEqual([1, 1]);
  // A slow read of one project no longer holds the other's reads.
  let slowDone = false;
  const slow = p
    .read(op("slow", { project: "cardigan", delay: 400 }))
    .then(() => {
      slowDone = true;
    });
  expect(
    body(await p.read(op("ok", { project: "sensen-godot" }))).threadId,
  ).toBe(b.threadId);
  expect(slowDone).toBe(false);
  await slow;
});

test("C-774: a project's reads stay in one worker, in order, while other projects read beside it", async () => {
  const p = pool({ workers: 2 });
  const projects = ["cardigan", "sensen-godot", "p-web"];
  const seen = new Map<string, { threadId: number; seen: number }[]>();
  for (let round = 0; round < 6; round++) {
    const reads = await Promise.all(
      projects.map((project) => p.read(op("ok", { project }))),
    );
    for (const read of reads) {
      const value = body(read) as {
        project: string;
        threadId: number;
        seen: number;
      };
      seen.set(value.project, [...(seen.get(value.project) ?? []), value]);
    }
  }
  for (const project of projects) {
    const reads = seen.get(project) ?? [];
    expect(reads).toHaveLength(6);
    // One worker for every read of the project, which saw them in order.
    expect(new Set(reads.map((r) => r.threadId)).size).toBe(1);
    for (let i = 1; i < reads.length; i++)
      expect(reads[i]?.seen).toBeGreaterThan(reads[i - 1]?.seen ?? 0);
  }
  // The third project shares a worker; the first two never do.
  expect(p.laneOf("cardigan")).not.toBe(p.laneOf("sensen-godot"));
});

test("C-774: a project keeps its first worker even when another worker is free", async () => {
  const p = pool({ workers: 2 });
  const first = body(await p.read(op("ok", { project: "cardigan" })));
  const home = p.laneOf("cardigan");
  const other = body(await p.read(op("ok", { project: "sensen-godot" })));
  expect(other.threadId).not.toBe(first.threadId);
  // A third project goes to the worker with fewer projects (ties: hash lane).
  const third = p.laneOf("p-web");
  body(await p.read(op("ok", { project: "p-web" })));
  expect(
    p
      .stats()
      .projects.map((ids) => ids.length)
      .sort(),
  ).toEqual([1, 2]);
  // cardigan's worker is busy; its next reads still queue there instead of
  // moving (a move would swap its version epoch and rebuild a cold cache).
  const busy = p.read(op("slow", { project: "cardigan", delay: 200 }));
  await vi.waitFor(() => expect(p.stats().running).toBe(1));
  const after = body(await p.read(op("ok", { project: "cardigan" })));
  expect(after.threadId).toBe(first.threadId);
  expect(after.seen).toBeGreaterThan(first.seen);
  expect(p.laneOf("cardigan")).toBe(home);
  expect(p.laneOf("p-web")).toBe(third);
  await busy;
});

test("C-774: a timed-out read still reports its queue wait and run time", async () => {
  const p = pool({ workers: 1, maxQueue: 8, timeoutMs: 100 });
  const running: Record<string, number> = {};
  const queued: Record<string, number> = {};
  const slow = p.read(op("slow", { delay: 300 }), undefined, (stage, ms) => {
    running[stage] = ms;
  });
  const waiting = p.read(op("ok"), undefined, (stage, ms) => {
    queued[stage] = ms;
  });
  slow.catch(() => undefined);
  waiting.catch(() => undefined);
  expect(await rejection(slow)).toMatchObject({ code: "read_timeout" });
  expect(await rejection(waiting)).toMatchObject({ code: "read_timeout" });
  expect(Object.keys(running).sort()).toEqual(["read_queue", "read_running"]);
  expect(running.read_queue).toBeLessThan(100);
  expect(
    (running.read_queue ?? 0) + (running.read_running ?? 0),
  ).toBeGreaterThanOrEqual(95);
  // Never started: the whole timeout was queue wait.
  expect(Object.keys(queued)).toEqual(["read_queue"]);
  expect(queued.read_queue).toBeGreaterThanOrEqual(95);
  await vi.waitFor(() => expect(p.stats().running).toBe(0));
});

test("C-774: warm projects are spread over workers that start at once and are told what to warm", async () => {
  const p = pool({ workers: 2, warmProjects: ["cardigan", "sensen-godot"] });
  // Both workers start before any read arrives.
  expect(p.stats().workers).toBe(2);
  expect(p.laneOf("cardigan")).not.toBe(p.laneOf("sensen-godot"));
  const a = body(await p.read(op("ok", { project: "cardigan" })));
  const b = body(await p.read(op("ok", { project: "sensen-godot" })));
  expect(a.warm).toEqual(["cardigan"]);
  expect(b.warm).toEqual(["sensen-godot"]);
  // A worker started later by a read warms the project that read it.
  const lazy = pool({ workers: 1 });
  expect(lazy.stats().workers).toBe(0);
  expect(body(await lazy.read(op("ok"))).warm).toEqual(["p1"]);
  // The Web server warms only once it listens; a closed pool starts nothing.
  const later = pool({ workers: 2 });
  expect(later.stats().workers).toBe(0);
  later.warm(["cardigan", "sensen-godot"]);
  expect(later.stats().workers).toBe(2);
  expect(later.laneOf("cardigan")).not.toBe(later.laneOf("sensen-godot"));
  const closed = pool({ workers: 2 });
  await closed.close();
  closed.warm(["cardigan"]);
  expect(closed.stats().workers).toBe(0);
});

test("host facts are asked on the Web thread and answered to the worker", async () => {
  const p = pool({ workers: 1 });
  const host = vi.fn(async () => ({ m1: { tools: "run-tools" } }));
  const result = body(await p.read(op("host"), host));
  expect(host).toHaveBeenCalledWith({
    project: "p1",
    machines: ["m1"],
    purpose: "needs",
  });
  expect(result.facts).toEqual({ m1: { tools: "run-tools" } });
});

test("closing rejects queued and running reads with 503 and stops the workers", async () => {
  const p = pool({ workers: 1, timeoutMs: 60_000 });
  const running = p.read(op("hang"));
  const queued = p.read(op("ok"));
  running.catch(() => undefined);
  queued.catch(() => undefined);
  await vi.waitFor(() => expect(p.stats().running).toBe(1));
  await p.close();
  expect(await rejection(running)).toMatchObject({ code: "read_unavailable" });
  expect(await rejection(queued)).toMatchObject({ code: "read_unavailable" });
  expect(await rejection(p.read(op("ok")))).toMatchObject({
    status: 503,
    code: "read_unavailable",
  });
  expect(p.stats()).toEqual({
    workers: 0,
    running: 0,
    queued: 0,
    projects: [[]],
  });
});

test("options come from the environment; 0 workers keeps reads inline", () => {
  expect(workbenchReadOptionsFromEnv({})).toEqual(WORKBENCH_READ_DEFAULTS);
  expect(
    workbenchReadOptionsFromEnv({
      CARDIGAN_WORKBENCH_READ_WORKERS: "3",
      CARDIGAN_WORKBENCH_READ_QUEUE: "10",
      CARDIGAN_WORKBENCH_READ_TIMEOUT_MS: "5000",
    }),
  ).toEqual({ workers: 3, maxQueue: 10, timeoutMs: 5000 });
  expect(
    workbenchReadOptionsFromEnv({ CARDIGAN_WORKBENCH_READ_WORKERS: "0" }),
  ).toBeUndefined();
  for (const env of [
    { CARDIGAN_WORKBENCH_READ_WORKERS: "-1" },
    { CARDIGAN_WORKBENCH_READ_WORKERS: "17" },
    { CARDIGAN_WORKBENCH_READ_QUEUE: "1.5" },
    { CARDIGAN_WORKBENCH_READ_QUEUE: "-1.5" },
    { CARDIGAN_WORKBENCH_READ_QUEUE: "x" },
    { CARDIGAN_WORKBENCH_READ_TIMEOUT_MS: "0" },
  ])
    expect(() => workbenchReadOptionsFromEnv(env)).toThrow();
  expect(() => new WorkbenchReadPool({ dbPath: "x", workers: 0 })).toThrow();
  expect(() => new WorkbenchReadPool({ dbPath: "x", maxQueue: 1.5 })).toThrow();
});

test("a queue limit of 0 or below is read as 1", async () => {
  for (const value of ["0", "-1", " -20 "])
    expect(
      workbenchReadOptionsFromEnv({ CARDIGAN_WORKBENCH_READ_QUEUE: value }),
    ).toEqual({ ...WORKBENCH_READ_DEFAULTS, maxQueue: 1 });
  for (const maxQueue of [0, -3]) {
    const p = pool({ workers: 1, maxQueue });
    expect(body(await p.read(op("ok"))).project).toBe("p1");
    expect(body(await p.read(op("ok"))).seen).toBe(2);
  }
});

test("only machines named by open helper notices are asked for host facts", () => {
  const state = {
    project_id: "p1",
    events: [],
    human_actions: [
      {
        id: "H-1",
        status: "open",
        terminal: { command: "x" },
        requested_by: "system",
        helper_upgrade: { machine_id: "m2", binding: "b" },
      },
      {
        id: "H-2",
        status: "done",
        terminal: { command: "x" },
        requested_by: "system",
        helper_upgrade: { machine_id: "m3", binding: "b" },
      },
      { id: "H-3", status: "open", requested_by: "system" },
    ],
  } as unknown as CommandState;
  expect(hostFactMachines(state)).toEqual(["m2"]);
});

test("Workbench reads through the worker match the inline reads and never build command state on the Web thread", async () => {
  const f = await webHarness({
    password: PASSWORD,
    diskStore: true,
    clock: { now: () => NOW },
    workbenchReads: { workers: 2, maxQueue: 16, timeoutMs: 30_000 },
  });
  cleanups.push(() => f.close());
  seedWebProject(f.store, f.dataDir);
  const cookie = await f.login(PASSWORD);
  let builds = 0;
  f.store.observe({
    stateBuild: () => {
      builds++;
    },
  });
  const base = `/api/projects/${encodeURIComponent(project_id)}`;
  const get = async (path: string, status = 200) => {
    const res = await call(f.port, `${base}${path}`, { cookie });
    expect(res.status, `${path}: ${res.body}`).toBe(status);
    return res;
  };
  const cards = await get("/cards?view=summary&sort=id&limit=50");
  const cardsVersion = await get(
    "/cards/version?view=summary&sort=id&limit=50",
  );
  expect(
    (cardsVersion.json as { snapshot_version: string }).snapshot_version,
  ).toBe((cards.json as { snapshot_version: string }).snapshot_version);
  const card = await get("/cards/C-1");
  await get("/cards/C-404", 404);
  const needs = await get("/needs-you");
  expect(needs.headers["x-cardigan-read-at"]).toBe(NOW);
  const counts = await get("/needs-you/counts");
  const version = await get("/needs-you/version");
  const again = await get("/needs-you/version");
  // One project, one worker: polls agree until the data changes.
  expect((again.json as { revision: string }).revision).toBe(
    (version.json as { revision: string }).revision,
  );
  const notices = await get("/notices");
  await get("/notices?before=nope", 400);
  const execution = await get("/execution");
  await get("/execution/assignments/A-404/runs", 404);
  await get("/prechecks/unknown-attempt", 404);
  await get("/merge-checks/00000000-0000-4000-8000-000000000000", 404);
  expect(builds).toBe(0);

  // The same reads inline on this store, at the same time, agree.
  const inline = async (read: WorkbenchReadOp) =>
    JSON.parse(
      (await runWorkbenchRead(f.store, read, async () => ({}))).body ?? "null",
    );
  const project = project_id as ProjectId;
  const strip = (value: unknown) => {
    const { snapshot_version: _v, ...rest } = value as Record<string, unknown>;
    return rest;
  };
  expect(strip(cards.json)).toEqual(
    strip(
      await inline({
        kind: "cards",
        project,
        url: `http://workbench.invalid${base}/cards?view=summary&sort=id&limit=50`,
        version: false,
        cache: { readScope: (cards.json as { read_scope: string }).read_scope },
      }),
    ),
  );
  expect(card.json).toEqual(
    await inline({
      kind: "card",
      project,
      card: "C-1" as CardId,
      url: `http://workbench.invalid${base}/cards/C-1`,
      mergeGateStatus: "disabled",
      now: NOW,
    }),
  );
  expect(needs.json).toEqual(
    await inline({ kind: "needs", project, counts: false, now: NOW }),
  );
  expect(counts.json).toEqual(
    await inline({ kind: "needs", project, counts: true, now: NOW }),
  );
  expect(notices.json).toEqual(await inline({ kind: "notices", project }));
  expect(execution.json).toEqual(
    await inline({
      kind: "execution",
      project,
      url: `http://workbench.invalid${base}/execution`,
      now: NOW,
      queueWarningMinutes: 30,
    }),
  );

  // A write by another connection shows on the next poll.
  f.store.uow.run((tx) => {
    const c = tx.cards.get(project_id, "C-1" as CardId);
    if (!c) throw new Error("missing fixture");
    tx.cards.put(project_id, { ...c, title: "Renamed by the writer" });
  });
  const after = await get("/cards/C-1");
  expect(JSON.stringify(after.json)).toContain("Renamed by the writer");
  const changed = await get("/needs-you/version");
  expect((changed.json as { revision: string }).revision).not.toBe(
    (version.json as { revision: string }).revision,
  );
});

test("C-774: on real workers a project's polls keep one version beside another project, and every read logs queue, state and query time", async () => {
  const logs: Readonly<Record<string, unknown>>[] = [];
  const f = await webHarness({
    password: PASSWORD,
    diskStore: true,
    clock: { now: () => NOW },
    workbenchReads: { workers: 2, maxQueue: 16, timeoutMs: 30_000 },
    log: (event) => logs.push(event),
  });
  cleanups.push(() => f.close());
  seedWebProject(f.store, f.dataDir);
  f.store.createProject({ id: "p-other" as ProjectId, name: "Other project" });
  const cookie = await f.login(PASSWORD);
  const version = async (project: string) => {
    const res = await call(
      f.port,
      `/api/projects/${project}/cards/version?view=summary&sort=id&limit=50`,
      { cookie },
    );
    expect(res.status, res.body).toBe(200);
    return (res.json as { snapshot_version: string }).snapshot_version;
  };
  // Each worker stamps its own epoch into the version: a project whose reads
  // switched workers would see its version flip without any write.
  const first = await version(project_id);
  for (let i = 0; i < 4; i++) {
    await Promise.all([version("p-other"), version("p-other")]);
    expect(await version(project_id)).toBe(first);
  }
  f.store.uow.run((tx) => {
    const c = tx.cards.get(project_id, "C-1" as CardId);
    if (!c) throw new Error("missing fixture");
    tx.cards.put(project_id, { ...c, title: "Renamed by the writer" });
  });
  const changed = await version(project_id);
  expect(changed).not.toBe(first);
  for (let i = 0; i < 3; i++) {
    await version("p-other");
    expect(await version(project_id)).toBe(changed);
  }

  const detail = await call(
    f.port,
    `/api/projects/${encodeURIComponent(project_id)}/cards/C-1`,
    { cookie },
  );
  expect(detail.status).toBe(200);
  const phases = logs
    .filter(
      (e) =>
        e.event === "web_http" &&
        e.route === "/api/projects/:project_id/cards/:id",
    )
    .map((e) => e.phases_ms as Record<string, number>)
    .at(-1);
  expect(phases).toBeDefined();
  for (const stage of [
    "read_queue",
    "read_worker",
    "read_state",
    "read_state_rebuild",
    "read_query",
    "sql_state",
    "timeline_sql",
    "references_sql",
    "events_sql",
    "assemble",
    "detail_version",
    "detail_serialize",
  ])
    expect(phases?.[stage], stage).toBeGreaterThanOrEqual(0);
  // State and query split the worker's run; the rebuild is part of the state.
  expect(phases?.read_state_rebuild).toBeLessThanOrEqual(
    (phases?.read_state ?? 0) + 0.001,
  );
  expect(
    (phases?.read_state ?? 0) + (phases?.read_query ?? 0),
  ).toBeLessThanOrEqual((phases?.read_worker ?? 0) + 0.5);

  // Needs You builds command state: the worker's first read rebuilds it, a
  // repeat with nothing written finds it cached.
  const needs = async () => {
    const res = await call(
      f.port,
      `/api/projects/${encodeURIComponent(project_id)}/needs-you`,
      { cookie },
    );
    expect(res.status).toBe(200);
    return logs
      .filter(
        (e) =>
          e.event === "web_http" &&
          e.route === "/api/projects/:project_id/needs-you",
      )
      .map((e) => e.phases_ms as Record<string, number>)
      .at(-1);
  };
  const cold = await needs();
  expect(cold?.read_state).toBeGreaterThan(0);
  expect(cold?.read_state_rebuild).toBeGreaterThan(0);
  const warm = await needs();
  expect(warm?.read_state).toBeGreaterThan(0);
  expect(warm?.read_state_rebuild).toBe(0);
});

test("C-774: reads that reach a warming worker at start answer fresh data, the same as inline reads", async () => {
  const f = await webHarness({
    password: PASSWORD,
    diskStore: true,
    clock: { now: () => NOW },
  });
  cleanups.push(() => f.close());
  seedWebProject(f.store, f.dataDir);
  const project = project_id as ProjectId;
  // A write just before the workers start: the warm-up must not hide it.
  f.store.uow.run((tx) => {
    const c = tx.cards.get(project_id, "C-1" as CardId);
    if (!c) throw new Error("missing fixture");
    tx.cards.put(project_id, { ...c, title: "Written before start" });
  });
  const p = new WorkbenchReadPool({
    dbPath: join(f.dataDir, "cardigan.db"),
    workers: 2,
    warmProjects: [project_id],
  });
  cleanups.push(() => p.close());
  const base = `http://workbench.invalid/api/projects/${project_id}`;
  const reads: WorkbenchReadOp[] = [
    {
      kind: "card",
      project,
      card: "C-1" as CardId,
      url: `${base}/cards/C-1`,
      mergeGateStatus: "disabled",
      now: NOW,
    },
    { kind: "needs", project, counts: false, now: NOW },
    {
      kind: "cards",
      project,
      url: `${base}/cards?view=summary&sort=id&limit=50`,
      version: false,
      cache: { readScope: "test" },
    },
  ];
  // Queued at once, while the worker is still starting and warming.
  const pooled = await Promise.all(
    reads.map((read) => p.read(read, async () => ({}))),
  );
  const strip = (value: unknown) => {
    const { snapshot_version: _v, ...rest } = value as Record<string, unknown>;
    return rest;
  };
  for (const [i, read] of reads.entries()) {
    const inline = await runWorkbenchRead(f.store, read, async () => ({}));
    expect(strip(body(pooled[i] ?? {}))).toEqual(strip(body(inline)));
  }
  expect(pooled[0]?.body).toContain("Written before start");
  // A write after the warm-up shows on the next read.
  f.store.uow.run((tx) => {
    const c = tx.cards.get(project_id, "C-1" as CardId);
    if (!c) throw new Error("missing fixture");
    tx.cards.put(project_id, { ...c, title: "Written after start" });
  });
  const after = await p.read(reads[0] as WorkbenchReadOp);
  expect(after.body).toContain("Written after start");
});
