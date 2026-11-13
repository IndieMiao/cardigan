import type { Run } from "@cardigan/domain";
import type { ReconcileChecks } from "@cardigan/git-service";

/**
 * P2a-3: when a verifier's writable build checkout may still be in use.
 *
 * The checkout belongs to the Assignment's Run, not to the Assignment: it is
 * prepared just before a Run is belled and removed by the cleanup loop in the
 * first round after the Assignment has no unfinished Run. `queued` counts as
 * unfinished because the Dispatcher prepares the checkout before it persists
 * the dispatch; `unknown` counts because its processes may still be alive.
 */
const UNFINISHED: ReadonlySet<Run["status"]> = new Set([
  "queued",
  "dispatched",
  "acked",
  "running",
  "unknown",
]);

export function buildCheckoutIdle(
  runs: readonly Run[],
  assignment_id: string,
): boolean {
  return !runs.some(
    (run) => run.assignment_id === assignment_id && UNFINISHED.has(run.status),
  );
}

/** Per Assignment: any unfinished Run, else the latest finish time. */
export function buildCheckoutFacts(
  runs: readonly Run[],
): NonNullable<ReconcileChecks["builds"]> {
  const facts = new Map<
    string,
    { assignment_id: string; unfinished: boolean; finished_at?: string }
  >();
  for (const run of runs) {
    const current = facts.get(run.assignment_id) ?? {
      assignment_id: run.assignment_id,
      unfinished: false,
    };
    if (UNFINISHED.has(run.status)) current.unfinished = true;
    else if (
      run.finished_at !== undefined &&
      (current.finished_at === undefined ||
        Date.parse(run.finished_at) > Date.parse(current.finished_at))
    )
      current.finished_at = run.finished_at;
    facts.set(run.assignment_id, current);
  }
  return [...facts.values()].sort((a, b) =>
    a.assignment_id.localeCompare(b.assignment_id),
  );
}
