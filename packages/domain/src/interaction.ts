import type { CommandState } from "./commands/core.js";
import type { Assignment, RuntimeRef } from "./entities.js";
import type { ProjectId, RunId } from "./ids.js";

export type InteractionState =
  | "confirmation"
  | "blocked"
  | "unknown"
  | "exited";
/** Host evidence only. No screen, command, prompt or credential fields. */
export interface InteractionSample {
  readonly interaction: InteractionState;
  readonly project_id: ProjectId;
  readonly assignment_id: Assignment["id"];
  readonly run_id: RunId;
  readonly runtime_ref: RuntimeRef;
  readonly observed_at: string;
  readonly stale_after_ms: number;
}
export function currentInteraction(
  state: Pick<CommandState, "project_id" | "assignments" | "runs">,
  sample: InteractionSample | undefined,
  now: string,
) {
  if (!sample) return;
  const a = state.assignments.find((a) => a.id === sample.assignment_id);
  const r = state.runs.findLast((r) => r.assignment_id === a?.id);
  const age = Date.parse(now) - Date.parse(sample.observed_at);
  if (
    !a ||
    a.external ||
    a.status !== "active" ||
    !a.runtime_ref ||
    sample.project_id !== state.project_id ||
    r?.id !== sample.run_id ||
    !["dispatched", "acked", "running", "unknown"].includes(r.status) ||
    JSON.stringify(a.runtime_ref) !== JSON.stringify(sample.runtime_ref) ||
    !Number.isFinite(age) ||
    age < 0 ||
    !Number.isSafeInteger(sample.stale_after_ms) ||
    sample.stale_after_ms < 0 ||
    age > sample.stale_after_ms ||
    Date.parse(sample.observed_at) < Date.parse(r.started_at ?? a.created_at)
  )
    return;
  return sample;
}
