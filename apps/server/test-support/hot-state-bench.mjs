/** C-639 hot command state: synthetic benchmark and shadow replay.
 *
 *   node test-support/hot-state-bench.mjs generate NEW_DIR [events-per-project] [system-share]
 *   node test-support/hot-state-bench.mjs bench DB full|hot [iterations]
 *   node test-support/hot-state-bench.mjs shadow DB
 *   node test-support/hot-state-bench.mjs background DB full|hot [seconds]
 *
 * `generate` only creates a new directory. `bench` and `shadow` open the given
 * database; for production replay pass a read-only COPY, never the live file:
 * `bench` appends a few synthetic comments and `shadow` writes nothing.
 * Output is JSON with timings, counts and check names only, never event bodies.
 * Build the workspace first (`pnpm build`).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  compareHotState,
  hotCommandEvents,
  listNeedsYou,
  postComment,
  projectSnapshot,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { PROJECT_EVENT_STREAM, Store } from "@cardigan/store";
import { Dispatcher } from "../dist/dispatch.js";
import { MergeExecutor } from "../dist/merge-loop.js";
import { seedScenarios } from "./synthetic-scenarios.mjs";

const [mode, target, ...rest] = process.argv.slice(2);
const NOW = "2026-06-15T12:00:00.000Z";
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

// Telemetry dominates closed history in production (run lifecycle, bells,
// session maintenance, GitHub dispatch records); the rest are business facts.
const TELEMETRY = [
  "run_queued",
  "run_dispatched",
  "run_started",
  "run_finished",
  "bell_wake_deferred",
  "session_maintenance_changed",
  "github_check_dispatch",
  "machine_selected",
];
const BUSINESS = [
  "comment_posted",
  "delivery_submitted",
  "review_submitted",
  "work_item_status_changed",
  "merge_check_finished",
];

function generate(dir, perProject = 300_000, systemShare = 0.1) {
  if (!dir) throw new Error("Expected a new output directory");
  mkdirSync(dir, { mode: 0o700 });
  const store = Store.open({
    dbPath: join(dir, "cardigan.db"),
    clock: { now: () => NOW },
    commandState: "full",
  });
  let seed = 639;
  let serial = 0;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const projects = ["bench-a", "bench-b", "bench-c"];
  const started = performance.now();
  for (const project of projects) {
    const created = store.createProject({ id: project, name: project });
    if (!created.ok) throw new Error(created.error.message);
    store.uow.run((tx) =>
      seedScenarios(tx, {
        // The published "production-like" entity shape; history is added below.
        size: {
          cards: 286,
          work_items: 916,
          timeline: 12500,
          events: 32750,
          runs: 4390,
          attachments: 0,
          decisions: 464,
        },
        project,
        now: NOW,
        random,
        eventId: () => `bench-${project}-${++serial}`,
        avatar: null,
        blobs: [{ sha256: "0".repeat(64), size: 0 }],
      }),
    );
    // Employees are global and uniquely named; keep each seed's names apart.
    store.uow.run((tx) => {
      for (const e of tx.employees.list())
        if (!e.name.includes("·"))
          tx.employees.put({ ...e, name: `${e.name}·${project}` });
    });
    // 98% of card history is closed; a few dozen cards stay open.
    const cards = store.uow.read((tx) => tx.cards.list(project));
    const open = new Set(cards.slice(-24).map((c) => c.id));
    store.uow.run((tx) => {
      for (const card of cards)
        if (!open.has(card.id))
          tx.cards.put(project, { ...card, status: "done", resolution: "done" });
      for (const a of tx.assignments.list(project)) {
        const item = a.work_item_id && tx.work_items.get(project, a.work_item_id);
        if (item && !open.has(item.card_id))
          tx.assignments.put(project, {
            ...a,
            status: "released",
            runtime_state: "released",
          });
      }
      for (const run of tx.runs.list(project))
        if (!["completed", "failed", "cancelled"].includes(run.status))
          tx.runs.put(project, { ...run, status: "completed" });
    });
    const openIds = [...open];
    const closedIds = cards.filter((c) => !open.has(c.id)).map((c) => c.id);
    const remaining = Math.max(0, perProject - 32750);
    const batch = 20_000;
    for (let done = 0; done < remaining; done += batch)
      store.uow.run((tx) => {
        for (let i = done; i < Math.min(remaining, done + batch); i++) {
          const r = random() / 0xffffffff;
          const card =
            r < systemShare
              ? undefined
              : r < systemShare + 0.02
                ? openIds[random() % openIds.length]
                : closedIds[random() % closedIds.length];
          const kinds = random() % 2 ? TELEMETRY : BUSINESS;
          tx.events.append(project, {
            id: `bench-${project}-${++serial}`,
            seq: tx.ids.nextEventSequence(project, card),
            ...(card ? { card_id: card } : {}),
            type: kinds[random() % kinds.length],
            actor: { kind: "system", project_id: project },
            payload: { run_id: `R-${random() % 100000}`, note: "synthetic" },
            created_at: NOW,
          });
        }
      });
  }
  const counts = store.database
    .prepare(
      "SELECT project_id, COUNT(*) AS events, SUM(card_id IS NULL) AS system FROM events GROUP BY project_id",
    )
    .all();
  store.close();
  out({
    mode: "generate",
    projects,
    counts,
    duration_ms: Math.round(performance.now() - started),
  });
}

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? Math.round(
        sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] *
          10,
      ) / 10
    : null;
};

function bench(db, scope, iterations = 20) {
  if (!db || !["full", "hot"].includes(scope))
    throw new Error("Expected DB full|hot");
  const startedOpen = performance.now();
  const store = Store.open({ dbPath: db, migrate: false, commandState: scope });
  const projects = store.listProjects().map((p) => p.id);
  const human = (project_id) => ({ kind: "human", project_id });
  const clock = { now: () => NOW };
  // Restart: the first synchronous state build per project blocks the loop.
  const startup = {};
  for (const project of projects) {
    const t = performance.now();
    const state = store.uow.read((tx) => loadCommandState(tx, project));
    startup[project] = {
      ms: Math.round(performance.now() - t),
      events: state.events.length,
    };
  }
  const ready_ms = Math.round(performance.now() - startedOpen);
  const timings = {};
  const time = (name, run) => {
    const t = performance.now();
    const value = run();
    (timings[name] ??= []).push(performance.now() - t);
    return value;
  };
  for (let i = 0; i < iterations; i++)
    for (const project of projects) {
      const card = store.uow.read((tx) =>
        tx.cards.list(project).find((c) => c.status !== "done"),
      );
      // A write command: state, reducer and persistence in one transaction.
      time("post_comment", () =>
        store.uow.run((tx) => {
          const state = loadCommandState(tx, project, undefined, {
            targets: [card.id],
          });
          const effect = postComment(
            state,
            human(project),
            { card_id: card.id, body: `bench ${i}` },
            { clock, ids: tx.ids },
          );
          if (!effect.ok) throw new Error(effect.error.message);
          persistEffect(tx, project, effect.value);
        }),
      );
      const state = time("command_state", () =>
        store.uow.read((tx) => loadCommandState(tx, project)),
      );
      time("list_needs_you", () => listNeedsYou(state, human(project), clock));
      time("project_snapshot", () => projectSnapshot(state, human(project)));
    }
  const memory = process.memoryUsage();
  store.close();
  out({
    mode: "bench",
    scope,
    iterations,
    ready_ms,
    startup,
    ms: Object.fromEntries(
      Object.entries(timings).map(([name, values]) => [
        name,
        { p50: quantile(values, 0.5), p95: quantile(values, 0.95) },
      ]),
    ),
    rss_mb: Math.round(memory.rss / 2 ** 20),
    heap_mb: Math.round(memory.heapUsed / 2 ** 20),
  });
}

function shadow(db) {
  if (!db) throw new Error("Expected DB");
  const full = Store.open({ dbPath: db, migrate: false, commandState: "full" });
  const hot = Store.open({ dbPath: db, migrate: false, commandState: "hot" });
  const report = [];
  try {
    for (const { id: project } of full.listProjects()) {
      const before = full.uow.read((tx) => loadCommandState(tx, project));
      const notified = hot.uow.read(
        (tx) => tx.hot_state_hints?.liveNotificationCards(project) ?? [],
      );
      const after = hot.uow.read((tx) => loadCommandState(tx, project));
      const expected = hotCommandEvents(before, notified);
      const sameEvents =
        expected.length === after.events.length &&
        expected.every((e, i) => e.id === after.events[i]?.id);
      const checks = compareHotState(before, after, { now: NOW });
      report.push({
        project,
        events: { full: before.events.length, hot: after.events.length },
        loader_matches_definition: sameEvents,
        failed: checks.filter((c) => !c.equal),
        checked: checks.length,
      });
    }
  } finally {
    full.close();
    hot.close();
  }
  out({ mode: "shadow", projects: report });
  if (report.some((p) => !p.loader_matches_definition || p.failed.length))
    process.exitCode = 1;
}

/** Idle background loops (no external IO) at production cadence: CPU, pauses, RSS. */
async function background(db, scope, seconds = 60) {
  if (!db || !["full", "hot"].includes(scope))
    throw new Error("Expected DB full|hot");
  const setup = Store.open({ dbPath: db, migrate: false, commandState: "full" });
  const clock = { now: () => new Date().toISOString() };
  // Production restarts with routed cursors; settle them in a separate open.
  for (const { id: project } of setup.listProjects())
    for (const c of [
      undefined,
      ...setup.uow.read((tx) => tx.cards.list(project)).map((c) => c.id),
    ])
      setup.advanceRouterCursor(
        project,
        c ?? PROJECT_EVENT_STREAM,
        setup.getUpdates({ project_id: project, ...(c ? { card_id: c } : {}) })
          .latest_seq,
      );
  setup.close();
  const started = performance.now();
  const store = Store.open({ dbPath: db, migrate: false, commandState: scope });
  const noIo = async () => {
    throw new Error("Benchmark attempted external IO");
  };
  const runtime = { status: noIo, wake: noIo, provision: noIo, release: noIo };
  const git = {
    projectOf: (project_id) => ({
      project_id,
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
  const merger = new MergeExecutor({ store, clock, git, onError: () => {} });
  // Restart: the first ticks warm every project's state on the main thread.
  const pauses = [];
  const tick = async (run) => {
    const t = performance.now();
    await run();
    pauses.push(performance.now() - t);
  };
  await tick(() => dispatcher.tick());
  await tick(() => merger.tick());
  const recovered_ms = Math.round(performance.now() - started);
  const warmup_max_ms = Math.round(Math.max(...pauses));
  pauses.length = 0;
  const cpu = process.cpuUsage();
  const from = performance.now();
  let n = 0;
  while (performance.now() - from < seconds * 1000) {
    await tick(() => dispatcher.tick());
    if (n++ % 5 === 0) await tick(() => merger.tick());
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const used = process.cpuUsage(cpu);
  const wall = performance.now() - from;
  const memory = process.memoryUsage();
  store.close();
  out({
    mode: "background",
    scope,
    seconds,
    restart: { recovered_ms, warmup_max_tick_ms: warmup_max_ms },
    idle_cpu_percent:
      Math.round(((used.user + used.system) / 1000 / wall) * 1000) / 10,
    tick_ms: { p95: quantile(pauses, 0.95), max: quantile(pauses, 1) },
    rss_mb: Math.round(memory.rss / 2 ** 20),
    heap_mb: Math.round(memory.heapUsed / 2 ** 20),
  });
}

if (mode === "generate")
  generate(
    target,
    rest[0] ? Number(rest[0]) : undefined,
    rest[1] ? Number(rest[1]) : undefined,
  );
else if (mode === "bench")
  bench(target, rest[0], rest[1] ? Number(rest[1]) : undefined);
else if (mode === "shadow") shadow(target);
else if (mode === "background")
  await background(target, rest[0], rest[1] ? Number(rest[1]) : undefined);
else throw new Error("Expected generate|bench|shadow|background");
