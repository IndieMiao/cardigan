import type { Assignment, Run } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import { runsOf } from "../run-index.js";
import type { CommandState } from "./core.js";

/** Queuing another Run doesn't end the CLI turn. Only consider the last one that actually started. */
export function systemEndedTurn(state: CommandState, owner: Assignment) {
  let last: Run | undefined;
  for (const r of runsOf(state.runs, owner.id)) {
    if (!r.started_at) continue;
    if (
      !last?.started_at ||
      r.started_at > last.started_at ||
      (r.started_at === last.started_at &&
        Number(r.id.slice(2)) > Number(last.id.slice(2)))
    )
      last = r;
  }
  if (
    last?.status !== "completed" ||
    !last.finished_at ||
    last.outcome !== "blocked"
  )
    return;
  const ref =
    last.bell_delivery?.runtime_ref ??
    last.recovery_runtime ??
    last.launch_publication?.runtime_ref;
  if (ref && JSON.stringify(ref) !== JSON.stringify(owner.runtime_ref)) return;
  return eventsOfType(state.events, "run_finished").some(
    (e) =>
      (e.payload as { run_id?: string }).run_id === last.id &&
      (e.payload as { finished_by?: string }).finished_by === "system",
  )
    ? last
    : undefined;
}
