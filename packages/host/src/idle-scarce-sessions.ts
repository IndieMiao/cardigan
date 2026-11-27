import {
  type Assignment,
  type CommandState,
  type Run,
  runsOf,
  sessionTurnEnded,
  untouchedQueuedRun,
  withAllAlternatives,
} from "@cardigan/domain";
import type { ReadRepositories } from "@cardigan/store";
import { assignmentResourceKeys } from "./run-resources.js";

/**
 * C-759: one idle work-item session holding a scarce resource, for host
 * operations' patrol. The session's previous turn ended (no Run on it is
 * unfinished except untouched queued ones), so its live terminal or its
 * queued Run is what keeps the resource (for example the only emulator slot
 * of a machine) from other work.
 */
export interface IdleScarceSession {
  readonly assignment_id: Assignment["id"];
  readonly machine_id: string;
  readonly card_id: string | null;
  /** Scarce resource keys the Assignment's work or its queued Runs hold. */
  readonly resources: readonly string[];
  /** The Run the live session was launched for (null: legacy launch). */
  readonly session_launch_run_id: Run["id"] | null;
  /** Untouched queued Runs: `host_ops_cancel_run` cancels them directly. */
  readonly queued_run_ids: readonly Run["id"][];
  readonly last_activity_at: string | null;
  readonly idle_ms: number | null;
  /** The tools that release it without a human. */
  readonly release: {
    readonly stop_session: "host_ops_stop_assignment";
    readonly cancel_queued: "host_ops_cancel_run" | null;
  };
}

/** C-759: the idle sessions holding a scarce resource, oldest first. */
export function idleScarceSessions(
  tx: ReadRepositories,
  state: CommandState,
  scarce: readonly string[],
  now: string,
): IdleScarceSession[] {
  if (!scarce.length) return [];
  const rows: IdleScarceSession[] = [];
  for (const a of state.assignments) {
    if (
      a.scope !== "work_item" ||
      a.status !== "active" ||
      a.external ||
      !a.runtime_ref ||
      !sessionTurnEnded(state, a)
    )
      continue;
    const runs = runsOf(state.runs, a.id);
    const queued = runs.filter(untouchedQueuedRun);
    const launch = a.runtime_ref.launch_generation?.run_id ?? null;
    const keys = new Set<string>();
    try {
      // C-815: an `android.any` session may take either of its options.
      for (const k of withAllAlternatives(
        assignmentResourceKeys(tx, state.project_id, a),
      ))
        keys.add(k);
    } catch {
      // An unreadable stored requirement names nothing; held keys still do.
    }
    for (const r of runs)
      if (r.id === launch || queued.includes(r))
        for (const k of r.resource_keys ?? []) keys.add(k);
    const resources = scarce.filter((k) => keys.has(k));
    if (!resources.length) continue;
    const last = Math.max(
      Date.parse(a.last_mcp_activity_at ?? "") || 0,
      ...runs.flatMap((r) =>
        [r.started_at, r.finished_at].map((at) => Date.parse(at ?? "") || 0),
      ),
    );
    rows.push({
      assignment_id: a.id,
      machine_id: a.machine_id,
      card_id:
        state.work_items.find((w) => w.id === a.work_item_id)?.card_id ?? null,
      resources,
      session_launch_run_id: launch,
      queued_run_ids: queued.map((r) => r.id),
      last_activity_at: last ? new Date(last).toISOString() : null,
      idle_ms: last ? Math.max(0, Date.parse(now) - last) : null,
      release: {
        stop_session: "host_ops_stop_assignment",
        cancel_queued: queued.length ? "host_ops_cancel_run" : null,
      },
    });
  }
  return rows.sort((x, y) => (y.idle_ms ?? 0) - (x.idle_ms ?? 0));
}
