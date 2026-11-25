import type { CommandState } from "./commands/core.js";
import {
  type ContextObservation,
  contextObservationCurrent,
} from "./context-usage.js";
import type { Assignment, Run } from "./entities.js";
import type { RunId } from "./ids.js";

/** Host-only evidence; no transcript text or caller-supplied paths. */
export interface HarnessActivity
  extends Pick<
    ContextObservation,
    "assignment_id" | "runtime_key" | "session_id" | "updated_at" | "source"
  > {
  readonly run_id: RunId;
  /** Latest protocol record explicitly ended a turn (not a tool call or an error). */
  readonly turn_ended?: true;
  readonly stale_after_ms: number;
  /** Lower bound of verified absence of model output (epoch ms); absent for incomplete reads. */
  readonly model_silent_since?: number;
  /** Last normal Claude record in the same bounded transcript read, before an error. */
  readonly last_progress_at?: string;
  /** Latest positively identified model output in this same session and workspace. */
  readonly model_output_at?: string;
  /** C-752: last write of the same transcript file, of any record (`transcript_mtime` only). */
  readonly written_at?: string;
  readonly error?:
    | "rate_limit"
    | "server_error"
    | "stream_disconnected"
    | "unclassified";
}

/** Verifies ownership and time direction, not whether progress is recent. */
export function associatedHarnessActivity(
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
    Date.parse(sample.updated_at) <
      Date.parse(run.started_at ?? assignment.created_at) ||
    !contextObservationCurrent(assignment, sample, state.events)
  )
    return;
  return sample;
}

export function currentHarnessActivity(
  state: CommandState,
  assignment: Assignment,
  now: string,
  sample: HarnessActivity | undefined,
): HarnessActivity | undefined {
  if (
    !sample ||
    Date.parse(now) - Date.parse(sample.updated_at) > sample.stale_after_ms
  )
    return;
  return associatedHarnessActivity(state, assignment, now, sample);
}

export function harnessActivityTime(sample: HarnessActivity | undefined) {
  return sample && !sample.error ? Date.parse(sample.updated_at) : undefined;
}

/** A record write, user echo, task start or generic progress is not evidence
 * that the model resumed. Recheck the output timestamp against the Run and
 * session generation independently of the containing transcript record. */
export function runModelOutputTime(
  state: CommandState,
  a: Assignment,
  run: Run,
  now: string,
  raw: HarnessActivity | undefined,
) {
  const sample = associatedHarnessActivity(state, a, now, raw);
  if (
    !sample ||
    sample.run_id !== run.id ||
    sample.source !== `${run.harness}:session_metadata` ||
    !sample.model_output_at
  )
    return;
  const at = Date.parse(sample.model_output_at);
  if (
    at <= Date.parse(sample.updated_at) &&
    associatedHarnessActivity(state, a, now, {
      ...sample,
      updated_at: sample.model_output_at,
    })
  )
    return at;
}
