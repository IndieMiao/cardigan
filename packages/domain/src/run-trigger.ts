import type { CommandState } from "./commands/core.js";
import type { Event, Run } from "./entities.js";
import { eventById } from "./event-index.js";
import { runById } from "./run-index.js";

/** Recovery preserves provenance only through fully bound host records. */
export function originalRunTrigger(
  state: Pick<CommandState, "project_id" | "runs" | "events">,
  run: Run,
): Event | undefined {
  let source = run;
  let event = eventById(state.events, source.trigger_event_id);
  const visited = new Set<string>();
  while (
    event &&
    [
      "run_dispatch_recovered",
      "run_preparation_recovered",
      "host_ops_action_finished",
    ].includes(event.type)
  ) {
    if (visited.has(event.id)) return undefined;
    visited.add(event.id);
    const p = event.payload as Record<string, unknown> | null;
    const host = event.type === "host_ops_action_finished";
    if (
      event.actor.kind !== "system" ||
      event.actor.project_id !== state.project_id ||
      p?.assignment_id !== source.assignment_id ||
      (host ? p?.run_id : p?.replacement_run_id) !== source.id
    )
      return undefined;
    // A stall has no previous Run: the host bound the live review signal at settlement.
    if (host && typeof p?.stall_review_trigger === "string") {
      const trigger = eventById(state.events, p.stall_review_trigger);
      return trigger?.type === "review_submitted" ||
        trigger?.type === "decision_resolved" ||
        trigger?.type === "instruction_issued"
        ? trigger
        : undefined;
    }
    const previous = runById(state.runs, host ? p?.previous_run_id : p?.run_id);
    if (
      !previous ||
      previous.assignment_id !== source.assignment_id ||
      previous.kind !== source.kind ||
      previous.trigger_event_id !== p?.original_trigger_event_id
    )
      return undefined;
    source = previous;
    event = eventById(state.events, source.trigger_event_id);
  }
  return event;
}
