// C-131: synthetic production-size data; never opens a configured/production DB.
// Build the chosen source tree first. Example:
// node apps/server/benchmarks/command-state.mjs . /tmp/c131-after 40
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? ".");
const output = resolve(
  process.argv[3] ?? join(tmpdir(), "command-state-benchmark"),
);
const iterations = Number(process.argv[4] ?? 40);
const moduleAt = (p) => import(pathToFileURL(join(root, p)).href);
const { Store } = await moduleAt("packages/store/dist/index.js");
const { Dispatcher } = await moduleAt("apps/server/dist/dispatch.js");
const { RuntimeMonitor } = await moduleAt(
  "apps/server/dist/dispatch-monitor.js",
);
const dataDir = mkdtempSync(join(tmpdir(), "cg-state-benchmark-"));
const store = Store.open({ dataDir });
const project = "benchmark";
const at = "2030-01-01T00:00:00.000Z";
const clock = { now: () => at };
const text = "Synthetic historical content. ".repeat(40);
const ref = {
  machine_id: "fixture",
  runtime_machine: "fixture",
  terminal_ref: "fixture",
  agent_name: "fixture",
};
store.createProject({ id: project });
store.uow.run((tx) => {
  for (let i = 1; i <= 20; i++)
    tx.employees.put({
      id: `E-${i}`,
      name: `Employee ${i}`,
      title: "Coder",
      bio: "",
      avatar: null,
      role_id: "coder",
      launch_profile_ref: null,
      status: "active",
      created_at: at,
      updated_at: at,
    });
  for (let i = 1; i <= 131; i++)
    tx.cards.put(project, {
      id: `C-${i}`,
      project_id: project,
      title: `Card ${i}`,
      goal: text,
      acceptance_criteria: ["Fixture"],
      source: { kind: "quote", text },
      priority: 1,
      status: i === 1 ? "in_progress" : "done",
      template: "dev",
      created_by: "human",
      created_at: at,
      related_cards: [],
      out_of_scope: [],
    });
  for (let i = 1; i <= 330; i++) {
    tx.work_items.put(project, {
      id: `W-${i}`,
      card_id: `C-${((i - 1) % 131) + 1}`,
      title: "Work",
      role_id: "coder",
      required: true,
      depends_on: [],
      completion_criteria: [],
      status: i === 1 ? "in_progress" : "accepted",
      kind: "produce",
      assignment_id: `A-${i}`,
    });
    tx.assignments.put(project, {
      id: `A-${i}`,
      scope: "work_item",
      work_item_id: `W-${i}`,
      role_id: "coder",
      role_version: 1,
      employee_id: `E-${((i - 1) % 20) + 1}`,
      machine_id: "fixture",
      mcp_token_id: `fixture-${i}`,
      created_at: at,
      status: i === 1 ? "active" : "released",
      runtime_state: i === 1 ? "idle" : "released",
      runtime_ref: i === 1 ? ref : null,
    });
  }
  for (let i = 1; i <= 1600; i++)
    tx.runs.put(project, {
      id: `R-${i}`,
      assignment_id: i === 1600 ? "A-1" : `A-${((i - 1) % 330) + 1}`,
      trigger_event_id: `history-${i}`,
      kind: "event",
      status: i === 1600 ? "running" : "completed",
      created_at: at,
      started_at: at,
      heartbeat_at: at,
      model: "fixture",
      agent_cli_version: "fixture",
      summary: text,
    });
  for (let i = 1; i <= 10000; i++)
    tx.events.append(project, {
      id: `history-${i}`,
      card_id: "C-1",
      seq: i,
      type: "benchmark_history",
      actor: { kind: "system", project_id: project },
      payload: { text },
      created_at: at,
    });
  for (let i = 1; i <= 4000; i++)
    tx.timeline.put(project, {
      id: `C-1#${i}`,
      short_id: `C-1#${i}`,
      card_id: "C-1",
      event_seq: i,
      type: "comment",
      body: text,
      author: "human",
      refs: [],
      mentions: [],
      retracted: false,
      created_at: at,
    });
});
// Historical events have already been routed, as in a running production server.
store.advanceRouterCursor(project, "C-1", 10000);
const runtime = {
  async *events(_ref, signal) {
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
  },
  status: async () => ({
    ok: true,
    value: { process: "alive", agent: "working", observed_seq: 1 },
  }),
};
const dispatcher = new Dispatcher({
  store,
  clock,
  runtime,
  snapshot: async () => {
    throw new Error("Unexpected launch");
  },
  startRun: async () => {
    throw new Error("Unexpected launch");
  },
});
const monitor = new RuntimeMonitor({ store, clock, runtime });
const tick = async () => {
  monitor.reconcile();
  await dispatcher.tick();
  monitor.reconcile();
};
try {
  const coldAt = performance.now();
  await tick();
  const coldMs = performance.now() - coldAt;
  await tick();
  const profiler = new Session();
  profiler.connect();
  await profiler.post("Profiler.enable");
  await profiler.post("Profiler.start");
  const measurements = {};
  for (const mode of ["idle", "write"]) {
    const elapsed = [];
    for (let i = 0; i < iterations; i++) {
      const started = performance.now();
      if (mode === "write")
        store.uow.run((tx) => {
          const run = tx.runs.get(project, "R-1600");
          tx.runs.put(project, { ...run, summary: `${text}${i}` });
        });
      await tick();
      elapsed.push(performance.now() - started);
    }
    elapsed.sort((a, b) => a - b);
    measurements[mode] = {
      mean_ms: elapsed.reduce((a, b) => a + b, 0) / iterations,
      p50_ms: elapsed[Math.floor(iterations * 0.5)],
      p95_ms: elapsed[Math.ceil(iterations * 0.95) - 1],
      max_ms: elapsed.at(-1),
    };
  }
  const { profile } = await profiler.post("Profiler.stop");
  profiler.disconnect();
  // Strip environment-specific paths from the export and the human-readable ranking.
  for (const node of profile.nodes) {
    const url = node.callFrame.url;
    if (url.startsWith("file://"))
      node.callFrame.url = relative(root, new URL(url).pathname);
    else if (url.startsWith(root)) node.callFrame.url = relative(root, url);
  }
  const parents = new Map();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parents.set(child, node);
  const grouped = new Map();
  let totalSamples = 0;
  for (const node of profile.nodes) {
    if (!node.hitCount) continue;
    totalSamples += node.hitCount;
    const frame = node.callFrame;
    const caller = !frame.url ? parents.get(node.id)?.callFrame : undefined;
    const entry = {
      function: `${frame.functionName || "(anonymous)"}${caller?.url ? ` ← ${caller.functionName || "(anonymous)"}` : ""}`,
      file: frame.url || caller?.url || "(V8)",
      line: (frame.url ? frame.lineNumber : (caller?.lineNumber ?? -1)) + 1,
      samples: node.hitCount,
    };
    const key = `${entry.function}:${entry.file}:${entry.line}`;
    const prior = grouped.get(key);
    if (prior) prior.samples += entry.samples;
    else grouped.set(key, entry);
  }
  const top = [...grouped.values()]
    .sort((a, b) => b.samples - a.samples)
    .slice(0, 10)
    .map((entry) => ({
      ...entry,
      percent: (100 * entry.samples) / totalSamples,
    }));
  const result = {
    node: process.version,
    rows: {
      cards: 131,
      assignments: 330,
      employees: 20,
      timeline: 4000,
      runs: 1600,
      events: 10000,
    },
    iterations,
    cold_ms: coldMs,
    measurements,
    cpu_top10: top,
  };
  writeFileSync(`${output}.cpuprofile`, JSON.stringify(profile));
  writeFileSync(`${output}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await monitor.stop();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
}
