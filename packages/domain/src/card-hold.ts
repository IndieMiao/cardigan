import type { Assignment, Card, Event, WorkItem } from "./entities.js";
import { eventById } from "./event-index.js";

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
