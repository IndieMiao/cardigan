import type {
  Decision,
  Delivery,
  Event,
  Review,
  WorkItem,
} from "./entities.js";
import { eventsForDecision } from "./event-index.js";
import { verificationTarget } from "./verification-activity.js";

type State = {
  decisions: readonly Decision[];
  deliveries: readonly Delivery[];
  work_items: readonly WorkItem[];
};

export function pendingSharedReview(
  decisions: readonly Decision[],
  deliveryId: string,
) {
  return decisions.some(
    (q) =>
      q.review_limit_group?.delivery_id === deliveryId &&
      q.blocking &&
      ["open", "snoozed", "provisional"].includes(q.status),
  );
}

/** The delivery, not just the SHA, must still be the one needing repair. */
export function sharedReworkItem(state: State, q: Decision) {
  const group = q.review_limit_group;
  if (!group || pendingSharedReview(state.decisions, group.delivery_id)) return;
  const target = state.deliveries.find((d) => d.id === group.delivery_id);
  if (
    target?.status !== "rejected" ||
    target.subject.value !== group.target_sha ||
    state.deliveries.some((d) => d.supersedes === target.id)
  )
    return;
  return state.work_items.find(
    (w) => w.id === target.work_item_id && w.status === "changes_requested",
  );
}

/** Re-read at routing and launch: a durable notification is not permission to work. */
export function reviewWakeBlocked(
  state: State & { events: readonly Event[]; reviews: readonly Review[] },
  event: Event | undefined,
  itemId?: string,
  alreadyQueued = false,
): boolean {
  if (!event || !itemId) return false;
  const p = event.payload as Record<string, unknown> | null;
  if (event.type === "review_submitted") {
    if (p?.review_limit_wait === true) return true;
    if (typeof p?.delivery_id !== "string") return false;
    const groups = state.decisions.filter(
      (q) =>
        q.review_limit_group?.delivery_id === p.delivery_id &&
        q.status !== "withdrawn",
    );
    if (!groups.length) return false;
    const target = state.deliveries.find((d) => d.id === p.delivery_id);
    if (target?.work_item_id !== itemId) return false;
    // Once continued, the resolution replaces older unconsumed wakes. A Run
    // already queued before the pause may serve that same current repair.
    return (
      target.status !== "rejected" ||
      groups.some(
        (q) =>
          q.status !== "resolved" ||
          (!alreadyQueued &&
            eventsForDecision(state.events, q.id).some(
              (e) => e.type === "decision_resolved" && e.seq > event.seq,
            )),
      )
    );
  }
  if (event.type !== "decision_resolved") return false;
  const q = state.decisions.find((q) => q.id === p?.decision_id);
  if (!q?.review_limit_group) return false;
  if (p?.rework_work_item_id === itemId)
    return sharedReworkItem(state, q)?.id !== itemId;
  const item = state.work_items.find((w) => w.id === itemId);
  return !(
    item &&
    Array.isArray(p?.resume_work_items) &&
    p.resume_work_items.includes(item.id) &&
    verificationTarget(item, state)
  );
}
