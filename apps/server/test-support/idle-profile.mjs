/** C-386 idle window. Only a newly generated synthetic database; no config discovery.
 * node test-support/idle-profile.mjs NEW_DIR web|background [seconds] [history]
 * The CLI profile includes startup; steady.cpuprofile covers only the warmed 60s window.
 */
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { release } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PROJECT_EVENT_STREAM, Store } from "@cardigan/store";
import { CleanupExecutor } from "../dist/cleanup-loop.js";
import { Dispatcher } from "../dist/dispatch.js";
import { MergeExecutor } from "../dist/merge-loop.js";
import { setTickProfiler, TickProfiler } from "../dist/tick-profile.js";
import { executionCapacityRevision } from "../dist/web/execution-capacity.js";
import { serveStream } from "../dist/web/stream.js";
import { seedMaintenanceHistory } from "./maintenance-history.mjs";
import { seedScenarios } from "./synthetic-scenarios.mjs";

const [out, mode, seconds = "60", history] = process.argv.slice(2);
const duration = Number(seconds) * 1000;
if (!out || !["web", "background"].includes(mode))
  throw new Error("Expected NEW_DIR web|background [seconds]");
if (!Number.isSafeInteger(duration) || duration < 1000 || duration > 600000)
  throw new Error("Expected a window between 1 and 600 seconds");
if (history !== undefined && history !== "history")
  throw new Error("Expected optional history flag");
mkdirSync(out, { mode: 0o700 });
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const project = "idle-synthetic";
const epoch = Date.parse("2026-06-15T12:00:00Z");
let origin = performance.now();
const clock = {
  now: () => new Date(epoch + performance.now() - origin).toISOString(),
};
const store = Store.open({ dbPath: join(out, "cardigan.db"), clock });
store.createProject({ id: project });
const size = {
  cards: 350,
  work_items: 1050,
  runs: 5500,
  events: 55000,
  timeline: 18075,
  attachments: 0,
  decisions: 590,
};
let seed = 386,
  serial = 0;
store.uow.run((tx) => {
  seedScenarios(tx, {
    size,
    project,
    now: clock.now(),
    random: () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0),
    eventId: () => `idle-event-${++serial}`,
    avatar: null,
    blobs: [{ sha256: "0".repeat(64), size: 0 }],
  });
  for (const {
    inactivity_stop,
    dispatch_stop,
    launch_publication,
    ...r
  } of tx.runs.list(project))
    tx.runs.put(project, {
      ...r,
      status: "completed",
      outcome: "completed",
      finished_at: clock.now(),
    });
  for (const c of tx.cards.list(project))
    if (c.status === "awaiting_merge")
      tx.cards.put(project, { ...c, status: "review" });
});
// Settle synthetic check history before observation, leaving event sizes/order intact.
store.database.exec(`UPDATE events SET type='merge_check_finished', doc=json_set(doc,'$.type','merge_check_finished','$.payload.status','passed')
  WHERE type IN ('merge_check_queued','merge_check_started')`);
const configuration = history
  ? seedMaintenanceHistory(store, project, clock.now())
  : undefined;
for (const c of [
  undefined,
  ...store.uow.read((tx) => tx.cards.list(project)).map((c) => c.id),
])
  store.advanceRouterCursor(
    project,
    c ?? PROJECT_EVENT_STREAM,
    store.getUpdates({ project_id: project, ...(c ? { card_id: c } : {}) })
      .latest_seq,
  );
const lines = [];
const profiler = new TickProfiler({
  sha,
  log: (line) => lines.push(line),
  reportIntervalMs: 0,
});
store.observe(profiler.storeObserver);
setTickProfiler(profiler);
const noIo = async () => {
  throw new Error("Idle fixture attempted external IO");
};
const runtime = { status: noIo, wake: noIo, provision: noIo, release: noIo };
const git = {
  projectOf: () => ({
    project_id: project,
    source_repo: "synthetic",
    base_branch: "main",
  }),
  repo: noIo,
  cleanup: noIo,
  deleteCheckCandidate: noIo,
  pushCheckCandidate: noIo,
  isBaselineAncestor: noIo,
};
const dispatcher = new Dispatcher({
  store,
  clock,
  runtime,
  snapshot: noIo,
  startRun: noIo,
});
const merger = new MergeExecutor({
  store,
  clock,
  git,
  ...(configuration
    ? { gate: { configuration, execution: { mode: "local", dataDir: out } } }
    : {}),
  onError: (error) => {
    throw error;
  },
});
const cleanup = new CleanupExecutor({ store, clock, git, runtime });
const stop = new AbortController();
let stream;
let frames = 0;
if (mode === "web") {
  const req = new EventEmitter();
  const res = new EventEmitter();
  Object.assign(res, {
    writableEnded: false,
    writeHead: () => {},
    write: () => {
      frames++;
      return true;
    },
    end: () => {
      res.writableEnded = true;
      res.emit("close");
    },
  });
  stream = serveStream({
    store,
    project_id: project,
    req,
    res,
    after: [],
    signal: stop.signal,
    capacityRevision: () => executionCapacityRevision(store),
    log: (e) => {
      throw new Error(JSON.stringify(e));
    },
  });
} else {
  await dispatcher.tick();
  await merger.tick();
  await cleanup.tick();
}
lines.length = 0;
const inspector = new Session();
inspector.connect();
await inspector.post("Profiler.enable");
await inspector.post("Profiler.start");
const observedFrom = new Date().toISOString();
origin = performance.now();
const cpu = process.cpuUsage();
const samples = [];
const sample = () =>
  samples.push({
    elapsed_ms: performance.now() - origin,
    cpu: process.cpuUsage(cpu),
    ...process.memoryUsage(),
  });
sample();
let ticks = 0;
while (performance.now() - origin < duration) {
  if (mode === "background") {
    await profiler.tick("dispatcher", () => dispatcher.tick());
    if (ticks % 5 === 0) await profiler.tick("merge", () => merger.tick());
    if (ticks === 0) await profiler.tick("cleanup", () => cleanup.tick());
    ticks++;
    sample();
  }
  await new Promise((resolve) =>
    setTimeout(
      resolve,
      Math.min(1000, Math.max(0, duration - (performance.now() - origin))),
    ),
  );
}
const usage = process.cpuUsage(cpu),
  wall = performance.now() - origin;
sample();
const { profile } = await inspector.post("Profiler.stop");
inspector.disconnect();
stop.abort();
await stream;
profiler.stop();
setTickProfiler(undefined);
const activeRuns = store.database
  .prepare(
    "SELECT count(*) AS n FROM runs WHERE json_extract(doc,'$.status') NOT IN ('completed','failed','cancelled')",
  )
  .get().n;
const report = {
  sha,
  source_dirty:
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      encoding: "utf8",
    }).trim() !== "",
  software: {
    node: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    arch: process.arch,
    kernel: release(),
    runtime: "synthetic-no-hc",
  },
  observed_from: observedFrom,
  observed_to: new Date().toISOString(),
  mode,
  seed: 386,
  size,
  history: Boolean(history),
  observed_rows: Object.fromEntries(
    ["events", "notifications", "deliveries"].map((table) => [
      table,
      store.database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
    ]),
  ),
  samples,
  activeRuns,
  check_capacity_rows: store.database
    .prepare("SELECT count(*) AS n FROM merge_check_capacity")
    .get().n,
  active_check_events: store.database
    .prepare(
      "SELECT count(*) AS n FROM events WHERE type IN ('merge_check_queued','merge_check_started','precheck_queued','precheck_started')",
    )
    .get().n,
  wall_ms: wall,
  cpu: usage,
  cpu_percent: (usage.user + usage.system) / (wall * 10),
  ticks,
  frames,
  lines,
};
writeFileSync(join(out, "steady.cpuprofile"), JSON.stringify(profile));
writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
store.close();
console.log(
  JSON.stringify({ ...report, lines: undefined, samples: undefined }),
);
