import type { CommandState } from "./commands/core.js";
import {
  type ContextObservation,
  contextObservationCurrent,
} from "./context-usage.js";
import type { Assignment } from "./entities.js";
import type { RunId } from "./ids.js";

/** Host-only evidence; no transcript text or caller-supplied paths. */
export interface HarnessActivity
  extends Pick<
    ContextObservation,
    "assignment_id" | "runtime_key" | "session_id" | "updated_at" | "source"
  > {
  readonly run_id: RunId;
  readonly stale_after_ms: number;
  readonly error?:
    | "rate_limit"
    | "server_error"
    | "stream_disconnected"
    | "unclassified";
}

export function currentHarnessActivity(
  state: CommandState,
  assignment: Assignment,
  now: string,
  sample: HarnessActivity | undefined,
): HarnessActivity | undefined {
  if (!sample || assignment.external || !assignment.runtime_ref) return;
  const run = state.runs.findLast((r) => r.assignment_id === assignment.id);
  const age = Date.parse(now) - Date.parse(sample.updated_at);
  if (
    run?.id !== sample.run_id ||
    !["running", "acked", "dispatched", "unknown"].includes(run.status) ||
    !Number.isFinite(age) ||
    age < 0 ||
    !Number.isSafeInteger(sample.stale_after_ms) ||
    sample.stale_after_ms < 0 ||
    age > sample.stale_after_ms ||
    Date.parse(sample.updated_at) <
      Date.parse(run.started_at ?? assignment.created_at) ||
    !contextObservationCurrent(assignment, sample, state.events)
  )
    return;
  return sample;
}

export function harnessActivityTime(sample: HarnessActivity | undefined) {
  return sample && !sample.error ? Date.parse(sample.updated_at) : undefined;
}
