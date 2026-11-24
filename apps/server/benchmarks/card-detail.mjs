// C-688: card detail read cost on a synthetic `cards` fixture; never opens a
// configured/production DB and only writes to a fresh copy. Build the chosen
// source tree first (run the same script against both trees), then:
//   pnpm exec tsc -b apps/server
//   pnpm fixture:generate --profile cards --out <new-dir>
//   node apps/server/benchmarks/card-detail.mjs <source-root> <fixture-dir> <out-prefix> [samples]
// Writes <out-prefix>.json and <out-prefix>.cpuprofile (large card, first screen).
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? ".");
const fixture = resolve(process.argv[3] ?? "");
const output = resolve(process.argv[4] ?? join(tmpdir(), "card-detail"));
const samples = Number(process.argv[5] ?? 40);
const moduleAt = (p) => import(pathToFileURL(join(root, p)).href);
const { Store } = await moduleAt("packages/store/dist/index.js");
const { runWorkbenchRead } = await moduleAt("apps/server/dist/web/read-ops.js");

const project = "synthetic";
const now = "2026-06-15T12:00:00.000Z";
// Small: one timeline entry. Medium: 68 entries, 11 attachments (like sensen
// C-48). Large: 300 entries, 12 attachments (like sensen C-43). Awaiting:
// waiting for merge, whose queue position needs the project's merge queue.
const CARDS = { small: "C-2", medium: "C-40", large: "C-3", awaiting: "C-20" };
// What the Web client asks for: the first screen (drawer and page send the
// same read), the tabs read on demand, and the complete deep-link read.
const REQUESTS = {
  first_screen: "?limit=20&section=overview",
  timeline_tab: "?section=timeline",
  work_tab: "?section=work",
  records_tab: "?section=records",
  attachments_tab: "?section=attachments",
  full: "?limit=20",
};

const stats = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const at = (q) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  return {
    p50: +at(0.5).toFixed(2),
    p95: +at(0.95).toFixed(2),
    max: +sorted.at(-1).toFixed(2),
  };
};
const yieldLoop = () => new Promise((resolve) => setImmediate(resolve));

const dir = mkdtempSync(join(tmpdir(), "card-detail-bench-"));
const dbPath = join(dir, "copy.db");
copyFileSync(join(fixture, "cardigan.db"), dbPath);
const store = Store.open({ dbPath });
// The merge queue is on in production, as in the C-507 measurement.
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
// Production reads land between background writes (runs, events) that move
// every version. One unrelated run update per sample keeps each read honest.
const busyRun = store.uow.read(
  (tx) => tx.runs.list(project).find((r) => r.status === "completed").id,
);
let writes = 0;
const backgroundWrite = () =>
  store.uow.run((tx) => {
    const run = tx.runs.get(project, busyRun);
    tx.runs.put(project, { ...run, summary: `background ${++writes}` });
  });
const read = (card, query, extra = {}) =>
  runWorkbenchRead(store, {
    kind: "card",
    project,
    card,
    url: `http://fixture/api/projects/${project}/cards/${card}${query}`,
    mergeGateStatus: "enabled",
    now,
    ...extra,
  });
async function measure(card, query, { write, extra } = {}) {
  const wall = [],
    cpu = [];
  let last;
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  for (let i = 0; i < samples; i++) {
    if (write) backgroundWrite();
    await yieldLoop();
    const cpuStart = process.cpuUsage();
    const start = performance.now();
    last = await read(card, query, extra);
    wall.push(performance.now() - start);
    const used = process.cpuUsage(cpuStart);
    cpu.push((used.user + used.system) / 1000);
  }
  delay.disable();
  return {
    last,
    row: {
      status: last.notModified ? 304 : 200,
      bytes: Buffer.byteLength(last.body ?? ""),
      ms: stats(wall.slice(1)),
      cpu_ms: stats(cpu.slice(1)),
      first_ms: +wall[0].toFixed(2),
      loop_block_max_ms: +(delay.max / 1e6).toFixed(2),
    },
  };
}

try {
  // Warm the process on unrelated cards: module JIT and the read worker's
  // once-per-process caches (collections, the project's event log for a done
  // card, the merge queue's project state for a waiting one). Reported apart.
  const cold = {};
  for (const card of ["C-9", "C-103", "C-21"]) {
    const start = performance.now();
    await read(card, REQUESTS.first_screen);
    cold[card] = +(performance.now() - start).toFixed(2);
  }
  const results = {};
  for (const [size, card] of Object.entries(CARDS)) {
    results[size] = {};
    for (const [name, query] of Object.entries(REQUESTS)) {
      const { last, row } = await measure(card, query, { write: true });
      // What a browser (Accept-Encoding: gzip) receives for the same answer.
      const zipped = await read(card, query, { acceptGzip: true });
      if (zipped.gzip) row.bytes_gzip = zipped.gzip.byteLength;
      // An open detail revalidating with the validator it holds (C-688):
      // nothing written meanwhile, and after an unrelated write.
      if (last.etag !== undefined) {
        const extra = { ifNoneMatch: last.etag };
        row.revalidate_idle = (await measure(card, query, { extra })).row;
        row.revalidate_after_write = (
          await measure(card, query, { extra, write: true })
        ).row;
      }
      results[size][name] = row;
    }
  }

  // CPU profile of the large card's first screen, the most frequent heavy read.
  const profiler = new Session();
  profiler.connect();
  await profiler.post("Profiler.enable");
  await profiler.post("Profiler.setSamplingInterval", { interval: 100 });
  await profiler.post("Profiler.start");
  for (let i = 0; i < samples; i++) {
    backgroundWrite();
    await read(CARDS.large, REQUESTS.first_screen);
  }
  const { profile } = await profiler.post("Profiler.stop");
  profiler.disconnect();
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
  let total = 0;
  for (const node of profile.nodes) {
    if (!node.hitCount) continue;
    total += node.hitCount;
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
  const cpu_top10 = [...grouped.values()]
    .sort((a, b) => b.samples - a.samples)
    .slice(0, 10)
    .map((e) => ({ ...e, percent: +((100 * e.samples) / total).toFixed(2) }));
  const result = {
    node: process.version,
    samples,
    cards: CARDS,
    cold_first_reads_ms: cold,
    results,
    cpu_top10,
  };
  writeFileSync(`${output}.cpuprofile`, JSON.stringify(profile));
  writeFileSync(`${output}.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}
