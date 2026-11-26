/** C-796 GitHub dispatch records on the heap: synthetic database and measurement.
 *
 *   node test-support/dispatch-heap-bench.mjs generate NEW_DIR [attempts] [--no-dispatch]
 *   node --expose-gc test-support/dispatch-heap-bench.mjs measure DB full|hot|lean|slim
 *
 * `generate` only creates a new directory: one project with 800 cards (95%
 * closed), business history, and `attempts` GitHub check attempts whose
 * records follow the journal's lifecycle (about a dozen saves per attempt).
 * `--no-dispatch` writes the same database without dispatch records, so the
 * heap difference between the two is what dispatch records occupy.
 * `measure` opens the database (pass a COPY for production replay; it writes
 * nothing), loads the event log, runs the journal reads the background and
 * the Web capacity page make, builds the command state, and prints JSON with
 * counts and heap numbers only. Build the workspace first (`pnpm build`).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { GithubDispatchJournal } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import { Store } from "@cardigan/store";

const [mode, target, ...rest] = process.argv.slice(2);
const NOW = "2026-11-26T12:00:00.000Z";
const PROJECT = "bench";
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

function generate(dir, attempts = 1600, withDispatch = true) {
  if (!dir) throw new Error("Expected a new output directory");
  mkdirSync(dir, { mode: 0o700 });
  const store = Store.open({
    dbPath: join(dir, "cardigan.db"),
    clock: { now: () => NOW },
    commandState: "full",
  });
  let seed = 796;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  store.createProject({ id: PROJECT, name: PROJECT });
  const cards = Array.from({ length: 800 }, (_, i) => `C-${i + 1}`);
  const open = new Set(cards.slice(-40));
  store.uow.run((tx) => {
    for (const id of cards)
      tx.cards.put(PROJECT, {
        id,
        project_id: PROJECT,
        title: `Synthetic ${id}`,
        goal: "synthetic",
        acceptance_criteria: [],
        status: open.has(id) ? "in_progress" : "done",
        priority: 2,
        created_by: "human",
        created_at: NOW,
      });
  });
  const append = (tx, card, type, payload) =>
    tx.events.append(PROJECT, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(PROJECT, card),
      card_id: card,
      type,
      actor: { kind: "system", project_id: PROJECT },
      payload,
      created_at: NOW,
    });
  // Business history: identical in both databases.
  store.uow.run((tx) => {
    for (let i = 0; i < 40_000; i++) {
      const card = cards[Math.floor(random() * cards.length)];
      append(tx, card, "comment_posted", {
        entry: `${card}#${i}`,
        body: "x".repeat(80 + Math.floor(random() * 200)),
      });
    }
  });
  let rows = 0;
  if (withDispatch)
    store.uow.run((tx) => {
      for (let n = 1; n <= attempts; n++) {
        const card = cards[Math.floor(random() * cards.length)];
        const attempt = `MC-${n}`;
        const delivery = `D-${n}`;
        const owner = { pid: 1000 + n, start: `boot-${n}:${n * 7}` };
        let intent = {
          project: PROJECT,
          card,
          attempt,
          key: (n * 2654435761).toString(16).padStart(64, "0"),
          startedAt: NOW,
          executor: "github",
          phase: "reserved",
          discoveryDeadlineAt: Date.parse(NOW) + 600_000,
          candidate: {
            repo: "synthetic/project",
            ref: `refs/heads/ci/${card}/${delivery}/${attempt}`,
            sha: "a".repeat(40),
            delivery,
          },
        };
        const save = (change) => {
          intent = { ...intent, ...change };
          for (const [k, v] of Object.entries(intent))
            if (v === undefined) delete intent[k];
          append(tx, card, "github_check_dispatch", intent);
          rows++;
        };
        const run = 900_000 + n;
        save({});
        save({ phase: "publishing", publisher: owner });
        save({ publicationDeadlineAt: Date.parse(NOW) + 120_000 });
        save({ phase: "dispatching", publisher: undefined, postOwner: owner });
        save({
          postOwner: undefined,
          dispatchedRunId: run,
          absenceNotBefore: Date.parse(NOW) + 30_000,
          dispatchResponse: {
            operation: "dispatch",
            method: "POST",
            status: 200,
            requestId: `REQ:${n}`,
            summary: `{"workflow_run_id":${run},"run_url":"https://api.github.com/repos/synthetic/project/actions/runs/${run}"}`,
          },
        });
        save({
          scanOwner: { ...owner, id: `scan-${n}`, verifier: "v".repeat(44) },
          nextDiscoveryAt: Date.parse(NOW) + 15_000,
        });
        save({ observedRunIds: [run] });
        save({
          scanOwner: undefined,
          identity: {
            id: run,
            run_attempt: 1,
            path: ".github/workflows/check.yml",
            event: "workflow_dispatch",
            head_branch: "main",
            head_sha: "c".repeat(40),
            actor: { login: "synthetic[bot]" },
            display_title: `cardigan/${card}/${delivery}/${attempt}/merge_check/${"a".repeat(40)}/${"b".repeat(40)}`,
            html_url: `https://github.com/synthetic/project/actions/runs/${run}`,
            created_at: NOW,
          },
          externalRun: {
            provider: "github",
            run_id: run,
            run_attempt: 1,
            html_url: `https://github.com/synthetic/project/actions/runs/${run}`,
            workflow_sha: "c".repeat(40),
          },
          boundByDispatchId: true,
        });
        if (random() < 0.3)
          save({
            maintenanceRetry: {
              failures: 1,
              retryAt: Date.parse(NOW) + 60_000,
              reason: "discovery_error",
            },
          });
        // Open cards keep a few running checks; everything else ran through.
        if (open.has(card) && random() < 0.25) continue;
        save({ maintenanceRetry: undefined, finished: true });
        if (random() < 0.9) {
          save({ deleting: true });
          save({ deleted: true });
        }
      }
    });
  const bytes = store.database
    .prepare(
      "SELECT type, COUNT(*) AS rows, SUM(length(doc)) AS bytes FROM events GROUP BY type",
    )
    .all();
  store.close();
  out({ mode: "generate", attempts, dispatch_rows: rows, by_type: bytes });
}

function heap() {
  globalThis.gc?.();
  globalThis.gc?.();
  return process.memoryUsage().heapUsed;
}
const mb = (bytes) => Math.round((bytes / 2 ** 20) * 10) / 10;

function measure(dbPath, scope) {
  if (typeof globalThis.gc !== "function")
    throw new Error("Run with node --expose-gc");
  const before = heap();
  const store = Store.open({ dbPath, commandState: scope, migrate: false });
  const view = store.uow.read((tx) => tx.events.listStreams?.(PROJECT));
  const loaded = heap();
  const journal = new GithubDispatchJournal(store);
  const unfinished = journal.unfinished().length;
  const admitted = journal.admitted().length;
  const executors = store.uow.read(
    (tx) => journal.unfinishedExecutorsAt(tx).length,
  );
  const all = journal.all().length;
  store.uow.read((tx) => loadCommandState(tx, PROJECT));
  const read = heap();
  let decoded = 0;
  let dormant = 0;
  const log = view?.base;
  if (log)
    for (let ord = log.start; ord < log.end; ord++) {
      const entry = log.entryAt(ord);
      if (entry?.type !== "github_check_dispatch") continue;
      if ("payload" in entry) decoded++;
      else dormant++;
    }
  const decodedBytes = log
    ? store.database
        .prepare(
          "SELECT COUNT(*) AS rows, COALESCE(SUM(length(doc)), 0) AS bytes FROM events WHERE type = 'github_check_dispatch'",
        )
        .get()
    : undefined;
  store.close();
  out({
    mode: "measure",
    scope,
    dispatch_rows: decodedBytes?.rows,
    dispatch_doc_mb: mb(decodedBytes?.bytes ?? 0),
    store_log: { decoded_dispatch: decoded, dormant_dispatch: dormant },
    journal: { unfinished, admitted, executors, all },
    heap_mb: {
      after_load: mb(loaded - before),
      after_reads: mb(read - before),
    },
  });
}

if (mode === "generate")
  generate(
    target,
    rest[0] && !rest[0].startsWith("--") ? Number(rest[0]) : undefined,
    !rest.includes("--no-dispatch"),
  );
else if (mode === "measure") measure(target, rest[0] ?? "hot");
else
  throw new Error(
    "Usage: dispatch-heap-bench.mjs generate NEW_DIR [attempts] [--no-dispatch] | measure DB scope",
  );
