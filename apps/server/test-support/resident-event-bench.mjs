/** C-785: resident heap of a project's in-memory event log, by event mix.
 *
 *   node --expose-gc test-support/resident-event-bench.mjs [audits] [business]
 *
 * Builds two synthetic databases in a new temporary directory with the same
 * rows: one types the read-audit rows `cross_card_read` (left out of the
 * in-memory log since C-785), the other gives the identical rows a type the
 * log keeps (the behaviour before C-785). Each database is then loaded in its
 * own child process, which reports the heap the loaded log keeps after a full
 * GC. Synthetic data only; prints JSON with sizes and timings, never bodies.
 * Build the workspace first (`pnpm build`).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Store } from "@cardigan/store";

const P = "bench";
const NOW = "2026-11-26T12:00:00.000Z";
// A coder Assignment actor as the MCP server records it (tool list included).
const TOOLS = [
  "whoami",
  "get_card",
  "get_updates",
  "ack_events",
  "post_comment",
  "heartbeat",
  "finish_run",
  "report_blocker",
  "request_human_action",
  "request_decision",
  "upload_attachment",
  "read_attachment",
  "project_snapshot",
  "get_capability_guide",
  "list_shared_files",
  "get_shared_file",
  "upload_shared_file",
  "commit_shared_file",
  "get_check_log",
  "request_macos_check",
  "run_probe",
  "submit_delivery",
  "request_recheck",
  "request_check",
];
const actor = (n) => ({
  kind: "assignment",
  project_id: P,
  assignment_id: `A-${1000 + (n % 300)}`,
  role_id: "coder",
  role_version: 23,
  allowed_tools: TOOLS,
  capabilities: ["produce"],
});

function generate(path, audits, business, auditType) {
  const store = Store.open({ dbPath: path, clock: { now: () => NOW } });
  const created = store.createProject({ id: P, name: P });
  if (!created.ok) throw new Error(created.error.message);
  const cards = 200;
  store.uow.run((tx) => {
    for (let c = 1; c <= cards; c++)
      tx.cards.put(P, {
        id: `C-${c}`,
        project_id: P,
        title: `Synthetic ${c}`,
        goal: "synthetic",
        acceptance_criteria: [],
        source: { kind: "quote", text: "synthetic" },
        out_of_scope: [],
        related_cards: [],
        repo: "example/repo",
        base_branch: "main",
        priority: 2,
        status: c > 20 ? "done" : "in_progress",
        template: "dev",
        created_by: "human",
        created_at: NOW,
      });
  });
  const seq = new Map();
  const next = (stream) => {
    const value = (seq.get(stream) ?? 0) + 1;
    seq.set(stream, value);
    return value;
  };
  let id = 0;
  // Interleave like production: audits arrive between ordinary events.
  const total = audits + business;
  const ratio = total ? audits / total : 0;
  let written = { audits: 0, business: 0 };
  for (let start = 0; start < total; start += 2000)
    store.uow.run((tx) => {
      for (let i = start; i < Math.min(total, start + 2000); i++) {
        const audit =
          written.audits < audits &&
          (written.business >= business || written.audits < (i + 1) * ratio);
        if (audit) {
          written.audits++;
          tx.events.append(P, {
            id: `ev-${++id}`,
            seq: next(""),
            type: auditType,
            actor: actor(i),
            payload:
              i % 5
                ? {
                    card_id: `C-${1 + (i % cards)}`,
                    tool: "get_card",
                    assignment_id: actor(i).assignment_id,
                    employee_id: `E-${1 + (i % 9)}`,
                  }
                : {
                    card_ids: Array.from(
                      { length: 12 },
                      (_, k) => `C-${1 + ((i + k) % cards)}`,
                    ),
                    card_count: 12,
                    tool: "project_snapshot",
                    assignment_id: actor(i).assignment_id,
                    employee_id: `E-${1 + (i % 9)}`,
                  },
            created_at: NOW,
          });
        } else {
          written.business++;
          const card = `C-${1 + (i % cards)}`;
          tx.events.append(P, {
            id: `ev-${++id}`,
            seq: next(card),
            card_id: card,
            type: "comment_posted",
            actor: actor(i),
            payload: {
              entry_id: `${card}#${i}`,
              body: `synthetic progress note ${i} `.repeat(8),
            },
            created_at: NOW,
          });
        }
      }
    });
  store.close();
  return written;
}

function measure(path) {
  const gc = globalThis.gc;
  if (!gc) throw new Error("Run the child with --expose-gc");
  const store = Store.open({ dbPath: path, migrate: false });
  try {
    gc();
    const before = process.memoryUsage().heapUsed;
    const started = performance.now();
    const kept = store.uow.read(
      (tx) => tx.events.listStreams?.(P).size ?? Number.NaN,
    );
    const ms = performance.now() - started;
    gc();
    const after = process.memoryUsage().heapUsed;
    const bytes = Number(
      store.database
        .prepare(
          "SELECT SUM(length(doc)) AS n FROM events WHERE project_id = ?",
        )
        .get(P).n,
    );
    return {
      streams: kept,
      load_ms: Math.round(ms),
      resident_heap_mb: +((after - before) / 2 ** 20).toFixed(1),
      table_doc_mb: +(bytes / 2 ** 20).toFixed(1),
    };
  } finally {
    store.close();
  }
}

if (process.argv[2] === "--measure") {
  process.stdout.write(`${JSON.stringify(measure(process.argv[3]))}\n`);
} else {
  const audits = Number(process.argv[2] ?? 36_000);
  const business = Number(process.argv[3] ?? 120_000);
  const dir = mkdtempSync(join(tmpdir(), "cg-c785-bench-"));
  try {
    const self = fileURLToPath(import.meta.url);
    const result = {};
    for (const [name, type] of [
      ["before_c785", "cross_card_read_resident"],
      ["after_c785", "cross_card_read"],
    ]) {
      const path = join(dir, `${name}.db`);
      const written = generate(path, audits, business, type);
      result[name] = {
        ...written,
        ...JSON.parse(
          execFileSync(
            process.execPath,
            ["--expose-gc", self, "--measure", path],
            { encoding: "utf8" },
          ),
        ),
      };
    }
    const saved =
      result.before_c785.resident_heap_mb - result.after_c785.resident_heap_mb;
    result.saved_mb = +saved.toFixed(1);
    result.saved_per_audit_bytes = audits
      ? Math.round((saved * 2 ** 20) / audits)
      : 0;
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
