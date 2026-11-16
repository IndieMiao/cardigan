/** C-339: synthetic dispatcher CPU window. No config discovery or external IO.
 * pnpm exec tsc -b apps/server
 * pnpm --filter @cardigan/server exec node test-support/background-profile.mjs /tmp/new-output
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { CpuProfileController, cpuProfileCommand } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import { PROJECT_EVENT_STREAM, Store } from "@cardigan/store";
import { Dispatcher } from "../dist/dispatch.js";
import { setTickProfiler, TickProfiler } from "../dist/tick-profile.js";
import { seedScenarios } from "./synthetic-scenarios.mjs";

const output = resolve(process.argv[2]);
// C-344: optional on/off pair reuses the same normal synthetic workload.
// No flag retains C-339's original direct-inspector experiment.
const switchMode = process.argv[3];
if (switchMode !== undefined && switchMode !== "on" && switchMode !== "off")
  throw new Error("Expected on or off");
mkdirSync(output, { mode: 0o700 }); // Existing directories are rejected.
const project = "synthetic";
const epoch = Date.parse("2026-06-15T12:00:00.000Z");
let origin;
const clock = {
  now: () =>
    new Date(epoch + (origin ? performance.now() - origin : 0)).toISOString(),
};
const store = Store.open({ dbPath: join(output, "cardigan.db"), clock });
store.createProject({ id: project, name: "合成后台剖析" });
let seed = 339,
  serial = 0;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
store.uow.run((tx) => {
  seedScenarios(tx, {
    size: {
      cards: 350,
      work_items: 1050,
      runs: 5500,
      events: 55000,
      timeline: 18075,
      attachments: 0,
      decisions: 590,
    },
    project,
    now: clock.now(),
    random,
    eventId: () => `synthetic-event-${++serial}`,
    avatar: null,
    blobs: [{ sha256: "0".repeat(64), size: 0 }],
  });
  // Presentation snapshots contain almost exclusively completed Runs. Add
  // unstarted failures (without recovery) to represent failed launch history.
  const runs = tx.runs.list(project);
  for (const [i, run] of runs.entries()) {
    if (i < 1000) {
      const { started_at, ...rest } = run;
      tx.runs.put(project, {
        ...rest,
        status: "failed",
        outcome: "failed",
        finished_at: clock.now(),
      });
    }
  }
  // Durable settled bells grow independently of the active candidate count.
  const insert = store.database.prepare(`INSERT INTO bell_attempts
    (project_id,id,assignment_id,run_id,notification_ids,started_at,lease_until,finished_at,outcome)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const [i, run] of runs.entries())
    insert.run(
      project,
      `bell-${i}`,
      run.assignment_id,
      run.id,
      "[]",
      new Date(epoch - 60000).toISOString(),
      clock.now(),
      clock.now(),
      i % 5 ? "sent" : "failed",
    );
});
// This is a steady history window, not a replay of 55k fresh notifications.
for (const card of [
  undefined,
  ...store.uow.read((tx) => tx.cards.list(project)).map((c) => c.id),
]) {
  store.advanceRouterCursor(
    project,
    card ?? PROJECT_EVENT_STREAM,
    store.getUpdates({
      project_id: project,
      ...(card ? { card_id: card } : {}),
    }).latest_seq,
  );
}
const state = store.uow.read((tx) => loadCommandState(tx, project));
const distribution = (rows, key) =>
  Object.fromEntries(
    [...new Set(rows.map((r) => r[key]))].map((v) => [
      v,
      rows.filter((r) => r[key] === v).length,
    ]),
  );
const shape = {
  seed: 339,
  events: state.events.length,
  runs: state.runs.length,
  assignments: state.assignments.length,
  run_status: distribution(state.runs, "status"),
  assignment_status: distribution(state.assignments, "status"),
  bell_attempts: 5500,
  events_sha256: createHash("sha256")
    .update(JSON.stringify(state.events))
    .digest("hex"),
};
const lines = [];
const profiler = new TickProfiler({
  log: (line) => lines.push(line),
  reportIntervalMs: 0,
});
setTickProfiler(profiler);
store.observe(profiler.storeObserver);
const runtime = {
  status: async () => ({
    ok: true,
    value: { process: "alive", agent: "working", observed_seq: 1 },
  }),
  wake: async () => ({ ok: true, value: { sent: true } }),
  release: async () => ({ ok: true, value: undefined }),
};
const dispatcher = new Dispatcher({
  store,
  runtime,
  clock,
  snapshot: async () => ({
    model: "synthetic",
    agent_cli_version: "synthetic",
  }),
  startRun: async () => {},
});
// Warm routing/caches before the same 60-second window in each version.
await profiler.tick("dispatcher", () => dispatcher.tick());
lines.length = 0;
profiler.report();
lines.length = 0;
const inspector = switchMode === undefined ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("Profiler.enable");
  await inspector.post("Profiler.start");
}
const controller = switchMode
  ? new CpuProfileController({
      dataDir: output,
      role: "background",
      sha: "0".repeat(40),
    })
  : undefined;
if (switchMode === "on")
  cpuProfileCommand({
    dataDir: output,
    action: "start",
    target: "background",
    seconds: 60,
  });
const delays = monitorEventLoopDelay({ resolution: 10 });
delays.enable();
origin = performance.now();
const cpu = process.cpuUsage();
let ticks = 0;
while (performance.now() - origin < 60000) {
  controller?.sync();
  await profiler.tick("dispatcher", () => dispatcher.tick());
  ticks++;
  // Same completion-to-next-tick delay as startDispatchLoop; no load filler.
  await new Promise((r) =>
    setTimeout(
      r,
      Math.min(1000, Math.max(0, 60000 - (performance.now() - origin))),
    ),
  );
}
await controller?.close(); // Include stop/publication in CPU and delay evidence.
const profile = inspector
  ? (await inspector.post("Profiler.stop")).profile
  : undefined;
inspector?.disconnect();
const wallMs = performance.now() - origin;
const usage = process.cpuUsage(cpu);
delays.disable();
profiler.report();
profiler.stop();
setTickProfiler(undefined);
const totals = {};
for (const line of lines.filter((l) => l.event === "tick_profile")) {
  for (const [key, value] of Object.entries(line.spans ?? {}))
    totals[key] = (totals[key] ?? 0) + value;
}
// Subtract only immediate children at every depth, never all descendants.
// This is exclusive wall time (including awaits), not CPU attribution.
const disjoint = Object.fromEntries(
  Object.entries(totals).map(([key, value]) => [
    key,
    value -
      Object.entries(totals)
        .filter(([child]) => child.slice(0, child.lastIndexOf(".")) === key)
        .reduce((sum, [, ms]) => sum + ms, 0),
  ]),
);
const report = {
  shape,
  wall_ms: wallMs,
  cpu: usage,
  cpu_percent: (usage.user + usage.system) / (wallMs * 10),
  ticks,
  cpu_profile_mode: switchMode ?? "direct-inspector",
  event_loop_p99_ms: delays.percentile(99) / 1e6,
  profile_file_count: controller
    ? readdirSync(join(output, "cpu-profiles", "background")).filter((name) =>
        name.endsWith(".cpuprofile"),
      ).length
    : undefined,
  event_loop: lines.find((l) => l.event === "event_loop_delay"),
  disjoint_span_ms_per_minute: Object.fromEntries(
    Object.entries(disjoint).map(([key, value]) => [
      key,
      (value * 60000) / wallMs,
    ]),
  ),
  lines,
};
writeFileSync(join(output, "window.json"), JSON.stringify(report, null, 2), {
  mode: 0o600,
});
if (profile)
  writeFileSync(join(output, "window.cpuprofile"), JSON.stringify(profile), {
    mode: 0o600,
  });
store.close();
console.log(JSON.stringify({ ...report, lines: undefined }, null, 2));
