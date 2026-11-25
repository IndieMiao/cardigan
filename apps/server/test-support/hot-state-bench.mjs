/** C-639 hot command state: synthetic benchmark and shadow replay.
 *
 *   node test-support/hot-state-bench.mjs generate NEW_DIR [events-per-project] [system-share]
 *   node test-support/hot-state-bench.mjs bench DB full|hot|lean|slim [iterations]
 *   node test-support/hot-state-bench.mjs shadow DB [hot|lean|slim]
 *   node test-support/hot-state-bench.mjs background DB full|hot|lean|slim [seconds]
 *
 * `generate` only creates a new directory. `bench` and `shadow` open the given
 * database; for production replay pass a read-only COPY, never the live file:
 * `bench` appends a few synthetic comments and `shadow` writes nothing.
 * Output is JSON with timings, counts and check names only, never event bodies.
 * Build the workspace first (`pnpm build`).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import {
  compareHotState,
  fullEventHistory,
  hotCardIds,
  hotCommandEvents,
  leanCommandEvents,
  listNeedsYou,
  postComment,
  projectSnapshot,
  slimCommandEvents,
} from "@cardigan/domain";
import {
  getCardTool,
  getUpdatesTool,
  loadCommandState,
  persistEffect,
} from "@cardigan/mcp-server";
import { PROJECT_EVENT_STREAM, Store } from "@cardigan/store";
import { Dispatcher } from "../dist/dispatch.js";
import { MergeExecutor } from "../dist/merge-loop.js";
import { lastSuccessfulWorkerBackup } from "../dist/worker-backup.js";
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
          tx.cards.put(project, {
            ...card,
            status: "done",
            resolution: "done",
          });
      for (const a of tx.assignments.list(project)) {
        const item =
          a.work_item_id && tx.work_items.get(project, a.work_item_id);
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
      // Closed cards rarely keep open questions or actions; open ones keep theirs.
      const closedCard = (id) => id !== undefined && !open.has(id);
      for (const q of tx.decisions.list(project))
        if (
          ["open", "snoozed", "provisional"].includes(q.status) &&
          closedCard(q.card_id) &&
          (q.affected_cards ?? []).every(closedCard)
        )
          tx.decisions.put(project, { ...q, status: "resolved" });
      for (const h of tx.human_actions.list(project))
        if (h.status === "open" && closedCard(h.card_id))
          tx.human_actions.put(project, { ...h, status: "done" });
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
        sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] * 10,
      ) / 10
    : null;
};

const SCOPES = ["full", "hot", "lean", "slim"];

/** C-671: decoded and dormant (not kept decoded) rows of a project's Store log. */
function storeLog(store, project, types = false) {
  const view = store.uow.read((tx) => tx.events.listStreams?.(project));
  const log = view?.base;
  if (!log) return undefined;
  return {
    rows: log.end,
    dormant: log.dormant,
    ...(types ? { dormant_types: Object.fromEntries(log.dormantTypes()) } : {}),
  };
}

/** Heap and RSS after a full collection when `--expose-gc` is on. */
function memory_() {
  globalThis.gc?.();
  const m = process.memoryUsage();
  return {
    rss_mb: Math.round(m.rss / 2 ** 20),
    heap_mb: Math.round(m.heapUsed / 2 ** 20),
    collected: typeof globalThis.gc === "function",
  };
}

async function bench(db, scope, iterations = 20) {
  if (!db || !SCOPES.includes(scope))
    throw new Error("Expected DB full|hot|lean|slim");
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
      log: storeLog(store, project),
    };
  }
  const ready_ms = Math.round(performance.now() - startedOpen);
  const timings = {};
  const time = async (name, run) => {
    const t = performance.now();
    const value = await run();
    timings[name] ??= [];
    timings[name].push(performance.now() - t);
    return value;
  };
  // C-649: agent read tools through their MCP handlers, as an active work
  // item Assignment on an open card (the synthetic seed has some per project).
  const agents = new Map(
    projects.map((project) => [project, agentContext(store, project)]),
  );
  for (let i = 0; i < iterations; i++)
    for (const project of projects) {
      const card = store.uow.read((tx) =>
        tx.cards.list(project).find((c) => c.status !== "done"),
      );
      // A write command: state, reducer and persistence in one transaction.
      await time("post_comment", () =>
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
      const state = await time("command_state", () =>
        store.uow.read((tx) => loadCommandState(tx, project)),
      );
      await time("list_needs_you", () =>
        listNeedsYou(state, human(project), clock),
      );
      await time("project_snapshot", () =>
        projectSnapshot(state, human(project)),
      );
      const agent = agents.get(project);
      if (agent) {
        await time("get_card", () =>
          getCardTool.handler({ card_id: agent.card }, agent.context),
        );
        await time("get_updates", () =>
          getUpdatesTool.handler({ card_id: agent.card }, agent.context),
        );
      }
    }
  const memory = process.memoryUsage();
  const collected = memory_();
  const logs = Object.fromEntries(
    projects.map((project) => [project, storeLog(store, project, true)]),
  );
  store.close();
  out({
    mode: "bench",
    logs,
    after_gc: collected,
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

/** An active work item Assignment on an open card, as an MCP tool context. */
function agentContext(store, project) {
  return store.uow.read((tx) => {
    const open = new Set(
      tx.cards
        .list(project)
        .filter((c) => !["done", "cancelled"].includes(c.status))
        .map((c) => c.id),
    );
    const items = new Map(tx.work_items.list(project).map((w) => [w.id, w]));
    const assignment = tx.assignments
      .list(project)
      .find(
        (a) =>
          a.status === "active" &&
          a.scope === "work_item" &&
          open.has(items.get(a.work_item_id)?.card_id),
      );
    const role =
      assignment &&
      tx.roles.list(project).find((r) => r.role_id === assignment.role_id);
    if (!assignment || !role) return undefined;
    return {
      card: items.get(assignment.work_item_id).card_id,
      context: {
        store,
        identity: {
          actor: {
            kind: "assignment",
            project_id: project,
            assignment_id: assignment.id,
            role_id: assignment.role_id,
          },
          assignment,
          role,
          token: { role_version: assignment.role_version },
        },
      },
    };
  });
}

function shadow(db, scope = "hot") {
  if (!db || !["hot", "lean", "slim"].includes(scope))
    throw new Error("Expected DB [hot|lean|slim]");
  const full = Store.open({ dbPath: db, migrate: false, commandState: "full" });
  const hot = Store.open({ dbPath: db, migrate: false, commandState: scope });
  const report = [];
  try {
    for (const { id: project } of full.listProjects()) {
      const before = full.uow.read((tx) => loadCommandState(tx, project));
      const notified = hot.uow.read(
        (tx) => tx.hot_state_hints?.liveNotificationCards(project) ?? [],
      );
      const notifiedEvents = hot.uow.read(
        (tx) => tx.hot_state_hints?.liveNotificationEvents(project) ?? [],
      );
      const after = hot.uow.read((tx) => loadCommandState(tx, project));
      // C-649: lean keeps the subjects of live notifications on the project stream.
      const expected =
        scope === "slim"
          ? slimCommandEvents(before, notified, new Set(notifiedEvents))
          : scope === "lean"
            ? leanCommandEvents(before, notified, new Set(notifiedEvents))
            : hotCommandEvents(before, notified);
      const hotCards = hotCardIds(before, notified).size;
      // C-643: compare the complete histories (telemetry journal included).
      const wanted = fullEventHistory(expected);
      const loaded = fullEventHistory(after.events);
      const sameEvents =
        wanted.length === loaded.length &&
        wanted.every((e, i) => e.id === loaded[i]?.id) &&
        expected.length === after.events.length &&
        expected.every((e, i) => e.id === after.events[i]?.id);
      const checks = [
        ...compareHotState(before, after, { now: NOW }),
        // C-649: the host's reader of retained branch-backup records.
        (() => {
          const backups = (s) =>
            JSON.stringify(
              s.assignments.map((a) => [
                a.id,
                lastSuccessfulWorkerBackup(s, a),
              ]),
            );
          return {
            name: "worker_backups",
            equal: backups(before) === backups(after),
          };
        })(),
      ];
      report.push({
        project,
        events: {
          full: fullEventHistory(before.events).length,
          hot: fullEventHistory(after.events).length,
          command: after.events.length,
        },
        log: storeLog(hot, project),
        cards: { total: before.cards.length, hot: hotCards },
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
  if (!db || !SCOPES.includes(scope))
    throw new Error("Expected DB full|hot|lean|slim");
  const setup = Store.open({
    dbPath: db,
    migrate: false,
    commandState: "full",
  });
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
  // C-649: the event-loop delay histogram measures the longest real pause
  // (a tick may span several synchronous slices with yields in between).
  const loop = monitorEventLoopDelay({ resolution: 10 });
  loop.enable();
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
  const warmup_loop_max_ms = Math.round(loop.max / 1e6);
  loop.reset();
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
  const idle_loop_max_ms = Math.round(loop.max / 1e6);
  loop.disable();
  const wall = performance.now() - from;
  const memory = process.memoryUsage();
  const collected = memory_();
  const logs = Object.fromEntries(
    store.listProjects().map(({ id }) => [id, storeLog(store, id, true)]),
  );
  store.close();
  out({
    mode: "background",
    logs,
    after_gc: collected,
    scope,
    seconds,
    restart: {
      recovered_ms,
      warmup_max_tick_ms: warmup_max_ms,
      warmup_loop_max_ms,
    },
    loop_max_ms: idle_loop_max_ms,
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
  await bench(target, rest[0], rest[1] ? Number(rest[1]) : undefined);
else if (mode === "shadow") shadow(target, rest[0]);
else if (mode === "background")
  await background(target, rest[0], rest[1] ? Number(rest[1]) : undefined);
else throw new Error("Expected generate|bench|shadow|background");
