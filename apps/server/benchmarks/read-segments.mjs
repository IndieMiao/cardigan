// C-774: where one Workbench read spends its time (state / rebuild / query),
// on a synthetic `cards` fixture, one read at a time, each after an unrelated
// background write. Never opens a configured/production DB; writes only to a
// fresh copy. Build first, then:
//   pnpm exec tsc -b apps/server
//   pnpm fixture:generate --profile cards --out <new-dir>
//   node apps/server/benchmarks/read-segments.mjs <source-root> <fixture-dir> <out-prefix> [samples] [cards] [baseline-cards]
// [baseline-cards] > 0 adds one resolved decision whose suggestion has an
// evidence baseline (seq 0) on the read cards and that many more cards, so the
// C-303 suggestion progress SQL runs (the generator writes no baselines).
// Writes <out-prefix>.json and <out-prefix>-<op>.cpuprofile for every op.
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? ".");
const fixture = resolve(process.argv[3] ?? "");
const output = resolve(process.argv[4] ?? join(tmpdir(), "read-segments"));
const samples = Number(process.argv[5] ?? 30);
const moduleAt = (p) => import(pathToFileURL(join(root, p)).href);
const { Store } = await moduleAt("packages/store/dist/index.js");
const { runWorkbenchRead } = await moduleAt("apps/server/dist/web/read-ops.js");

const project = "synthetic";
const now = "2026-06-15T12:00:00.000Z";
const base = `http://fixture/api/projects/${project}`;
// Cards to read (default: the `cards` profile's waiting-for-merge and large
// cards); pass e.g. `C-3,C-80` for the `diagnostics` profile.
const cards = (process.argv[6] ?? "C-20,C-3").split(",");
const OPS = {
  ...Object.fromEntries(
    cards.map((id) => [
      `card_${id}`,
      {
        kind: "card",
        project,
        card: id,
        url: `${base}/cards/${id}?limit=20&section=overview`,
        mergeGateStatus: "enabled",
        now,
      },
    ]),
  ),
  needs: { kind: "needs", project, counts: false, now },
  needs_version: {
    kind: "needs_version",
    project,
    context: "bench",
    now,
    readScope: "bench",
  },
  cards: {
    kind: "cards",
    project,
    url: `${base}/cards?view=summary&sort=id&limit=50`,
    version: false,
    cache: { readScope: "bench" },
  },
};

const stats = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const at = (q) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return { p50: +at(0.5).toFixed(2), p90: +at(0.9).toFixed(2) };
};

const dir = mkdtempSync(join(tmpdir(), "read-segments-"));
const dbPath = join(dir, "copy.db");
copyFileSync(join(fixture, "cardigan.db"), dbPath);
const store = Store.open({ dbPath });
store.uow.run((tx) =>
  tx.events.append(project, {
    id: "benchmark-queue",
    seq: tx.ids.nextEventSequence(project, undefined),
    type: "merge_queue_configured",
    actor: { kind: "system", project_id: project },
    payload: { max_batch_size: 3 },
    created_at: now,
  }),
);
const baselineCards = Number(process.argv[7] ?? 0);
if (baselineCards > 0)
  store.uow.run((tx) => {
    const ids = [
      ...new Set([
        ...cards,
        ...tx.cards
          .list(project)
          .map((c) => c.id)
          .slice(0, baselineCards),
      ]),
    ];
    const original = tx.decisions.list(project)[0];
    tx.decisions.put(project, {
      ...original,
      id: "Q-bench-baseline",
      card_id: ids[0],
      affected_cards: ids.slice(1),
      status: "resolved",
      suggestion: {
        option: original.options?.[0]?.key ?? "ok",
        rationale: "benchmark",
        by: { kind: "system", project_id: project },
        at: now,
        basis: "benchmark",
        evidence_baseline: Object.fromEntries(ids.map((id) => [id, 0])),
      },
    });
  });
const busyRun = store.uow.read(
  (tx) => tx.runs.list(project).find((r) => r.status === "completed").id,
);
let writes = 0;
const backgroundWrite = () =>
  store.uow.run((tx) => {
    const run = tx.runs.get(project, busyRun);
    tx.runs.put(project, { ...run, summary: `background ${++writes}` });
  });

const tidy = (profile) => {
  for (const node of profile.nodes) {
    const url = node.callFrame.url;
    const path = url.startsWith("file://") ? new URL(url).pathname : url;
    if (path.startsWith(root)) node.callFrame.url = relative(root, path);
    else if (path.startsWith("/"))
      node.callFrame.url = `benchmarks/${path.split("/").at(-1)}`;
  }
  return profile;
};
const top = (profile, n = 8) => {
  const parents = new Map();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parents.set(child, node);
  const grouped = new Map();
  let total = 0;
  for (const node of profile.nodes) {
    if (!node.hitCount) continue;
    total += node.hitCount;
    const frame = node.callFrame;
    const caller = !frame.url ? parents.get(node.id)?.callFrame : undefined;
    const fn = `${frame.functionName || "(anonymous)"}${caller?.url ? ` ← ${caller.functionName || "(anonymous)"}` : ""}`;
    const file = frame.url || caller?.url || "(V8)";
    const line =
      (frame.url ? frame.lineNumber : (caller?.lineNumber ?? -1)) + 1;
    const key = `${fn}:${file}:${line}`;
    const prior = grouped.get(key) ?? { function: fn, file, line, samples: 0 };
    prior.samples += node.hitCount;
    grouped.set(key, prior);
  }
  return [...grouped.values()]
    .sort((a, b) => b.samples - a.samples)
    .slice(0, n)
    .map((e) => ({ ...e, percent: +((100 * e.samples) / total).toFixed(1) }));
};

try {
  const cold = {};
  for (const [name, op] of Object.entries(OPS)) {
    const result = await runWorkbenchRead(store, op);
    cold[name] = Object.fromEntries(
      ["read_state", "read_state_rebuild", "read_query", "suggestion_sql"]
        .filter((k) => result.timings[k] !== undefined)
        .map((k) => [k, +result.timings[k].toFixed(2)]),
    );
  }
  const results = {};
  const profiles = {};
  for (const [name, op] of Object.entries(OPS)) {
    const series = {
      total: [],
      read_state: [],
      read_state_rebuild: [],
      read_query: [],
      suggestion_sql: [],
    };
    const profiler = new Session();
    profiler.connect();
    await profiler.post("Profiler.enable");
    await profiler.post("Profiler.setSamplingInterval", { interval: 100 });
    await profiler.post("Profiler.start");
    for (let i = 0; i < samples; i++) {
      backgroundWrite();
      const started = performance.now();
      const result = await runWorkbenchRead(store, op);
      series.total.push(performance.now() - started);
      for (const k of Object.keys(series))
        if (k !== "total" && result.timings[k] !== undefined)
          series[k].push(result.timings[k]);
    }
    const { profile } = await profiler.post("Profiler.stop");
    profiler.disconnect();
    writeFileSync(
      `${output}-${name}.cpuprofile`,
      JSON.stringify(tidy(profile)),
    );
    profiles[name] = top(profile);
    results[name] = Object.fromEntries(
      Object.entries(series)
        .filter(([, xs]) => xs.length)
        .map(([k, xs]) => [k, stats(xs)]),
    );
  }
  const report = {
    node: process.version,
    samples,
    cold_ms: cold,
    results,
    cpu_top: profiles,
  };
  writeFileSync(`${output}.json`, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report.results, null, 1)}\n`);
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
