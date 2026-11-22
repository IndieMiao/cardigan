import type { CommandState } from "./commands/core.js";
import type { Assignment, Card, Event, Run, WorkItem } from "./entities.js";
import { eventById } from "./event-index.js";
import { queuedRun, runById, runsOf } from "./run-index.js";
import { parkedPauseRepair } from "./shared-review-wake.js";

type HoldState = {
  readonly cards: readonly Card[];
  readonly work_items: readonly WorkItem[];
  readonly events?: readonly Event[];
  readonly runs?: readonly Run[];
};

/** Keep legacy project-stream recovery events bound to their verified source. */
export function assignmentCardId(
  assignment: Assignment,
  state: HoldState,
  triggerEventId?: string,
) {
  if (assignment.scope === "work_item")
    return state.work_items.find((w) => w.id === assignment.work_item_id)
      ?.card_id;
  const events = state.events ?? [];
  const runs = state.runs ?? [];
  let trigger = eventById(events, triggerEventId);
  const visited = new Set<string>();
  while (trigger && !trigger.card_id) {
    if (
      visited.has(trigger.id) ||
      trigger.actor.kind !== "system" ||
      ![
        "run_dispatch_recovered",
        "run_preparation_recovered",
        "host_ops_action_finished",
      ].includes(trigger.type)
    )
      return undefined;
    visited.add(trigger.id);
    const p = trigger.payload as Record<string, unknown> | null;
    if (!p || typeof p !== "object" || Array.isArray(p)) return undefined;
    const host = trigger.type === "host_ops_action_finished";
    const next = runById(runs, host ? p.run_id : p.replacement_run_id);
    const previous = runById(runs, host ? p.previous_run_id : p.run_id);
    if (
      p.assignment_id !== assignment.id ||
      !next ||
      next.assignment_id !== assignment.id ||
      next.trigger_event_id !== trigger.id ||
      !previous ||
      previous.assignment_id !== assignment.id ||
      previous.kind !== next.kind ||
      previous.trigger_event_id !== p.original_trigger_event_id
    )
      return undefined;
    const source = eventById(events, previous.trigger_event_id);
    if (source?.actor.project_id !== trigger.actor.project_id) return undefined;
    trigger = source;
  }
  return trigger?.card_id;
}

/** A queued record with no execution or unsettled launch can wait beside other standing work. */
export function standingRunDormant(assignment: Assignment, run: Run): boolean {
  return (
    assignment.scope === "standing" &&
    run.assignment_id === assignment.id &&
    run.status === "queued" &&
    !run.started_at &&
    !run.dispatch_stop &&
    !run.inactivity_stop &&
    (!run.launch_publication || run.launch_publication.phase === "exited")
  );
}

export function heldStandingRun(
  assignment: Assignment,
  run: Run,
  state: HoldState,
): boolean {
  return (
    standingRunDormant(assignment, run) &&
    assignmentCardHeld(assignment, state, run.trigger_event_id)
  );
}

export function runnableQueuedRun(
  assignment: Assignment,
  state: CommandState,
): Run | undefined {
  const first = queuedRun(state.runs, assignment.id);
  const held = (r: Run) =>
    heldStandingRun(assignment, r, state) ||
    parkedPauseRepair(state, assignment, r);
  if (!first || !held(first)) return first;
  return runsOf(state.runs, assignment.id).find(
    (r) => r.status === "queued" && !held(r),
  );
}

// Store publishes immutable arrays; writes and rollbacks use their own snapshots.
const heldCards = new WeakMap<readonly Card[], ReadonlySet<string>>();

/** Read from the current transaction snapshot at each execution boundary. */
export function assignmentCardHeld(
  assignment: Assignment,
  state: HoldState,
  triggerEventId?: string,
): boolean {
  let held = heldCards.get(state.cards);
  if (!held) {
    held = new Set(state.cards.filter((c) => c.hold).map((c) => c.id));
    heldCards.set(state.cards, held);
  }
  if (!held.size) return false;
  const card = assignmentCardId(assignment, state, triggerEventId);
  return !!card && held.has(card);
}
