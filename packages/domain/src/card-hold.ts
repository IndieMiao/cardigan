import type { Assignment, Card, Event, Run, WorkItem } from "./entities.js";
import { eventById } from "./event-index.js";
import { queuedRun, runsOf } from "./run-index.js";

type HoldState = {
  readonly cards: readonly Card[];
  readonly work_items: readonly WorkItem[];
  readonly events?: readonly Event[];
};

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
  state: HoldState & { readonly runs: readonly Run[] },
): Run | undefined {
  const first = queuedRun(state.runs, assignment.id);
  if (!first || !heldStandingRun(assignment, first, state)) return first;
  return runsOf(state.runs, assignment.id).find(
    (r) => r.status === "queued" && !heldStandingRun(assignment, r, state),
  );
}

// Store publishes immutable arrays; writes and rollbacks use their own snapshots.
const heldCards = new WeakMap<readonly Card[], ReadonlySet<string>>();

/** Read from the current transaction snapshot at each execution boundary. */
export function assignmentCardHeld(
  assignment: Assignment,
  state: {
    readonly cards: readonly Card[];
    readonly work_items: readonly WorkItem[];
    readonly events?: readonly Event[];
  },
  triggerEventId?: string,
): boolean {
  let held = heldCards.get(state.cards);
  if (!held) {
    held = new Set(state.cards.filter((c) => c.hold).map((c) => c.id));
    heldCards.set(state.cards, held);
  }
  if (!held.size) return false;
  if (assignment.scope !== "work_item") {
    const triggerCard = state.events
      ? eventById(state.events, triggerEventId)?.card_id
      : undefined;
    return !!triggerCard && held.has(triggerCard);
  }
  const item = state.work_items.find((w) => w.id === assignment.work_item_id);
  return !!item && held.has(item.card_id);
}
