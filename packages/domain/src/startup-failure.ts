import type { CommandState } from "./commands/core.js";
import type { Assignment, Run } from "./entities.js";
import { eventsOfType } from "./event-index.js";
import { runsOf } from "./run-index.js";

/**
 * Startup failures stay open after their Run is cancelled: only a later
 * started Run (the session recovered) or the Assignment's release settles
 * them. C-752: a session that never reached the Card tools is one of them.
 */
export const STARTUP_FAILURE_REASONS: readonly string[] = [
  "recovery_startup_failed",
  "runtime_exited",
  "mcp_unavailable",
];

export function startupFailureResolved(state: CommandState, run: Run): boolean {
  return (
    state.assignments.find((a) => a.id === run.assignment_id)?.status ===
      "released" ||
    state.runs.some(
      (r) =>
        r.assignment_id === run.assignment_id &&
        r.started_at &&
        Number(r.id.slice(2)) > Number(run.id.slice(2)),
    )
  );
}

/**
 * C-752: the dispatcher reported this Assignment's startup failure and nobody
 * has restarted the session yet. Its handling belongs to that report (PM or
 * the human restarts it); session maintenance must not retire it meanwhile.
 */
export function openStartupFailure(
  state: CommandState,
  a: Assignment,
): boolean {
  const runs = runsOf(state.runs, a.id);
  if (!runs.length) return false;
  const ids = new Set(runs.map((r) => r.id));
  return eventsOfType(state.events, "run_dispatch_stalled").some((e) => {
    const p = e.payload as { run_id?: string; reason?: string } | null;
    if (!p?.run_id || !ids.has(p.run_id as Run["id"])) return false;
    if (!STARTUP_FAILURE_REASONS.includes(String(p.reason))) return false;
    const run = runs.find((r) => r.id === p.run_id);
    return !!run && !startupFailureResolved(state, run);
  });
}
