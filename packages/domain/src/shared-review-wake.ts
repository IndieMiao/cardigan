import type { CommandState } from "./commands/core.js";
import type {
  Assignment,
  Decision,
  Delivery,
  Event,
  Review,
  Run,
  WorkItem,
} from "./entities.js";
import { eventsForDecision } from "./event-index.js";
import { originalRunTrigger } from "./run-trigger.js";
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
function reviewWakeDisposition(
  state: State & { events: readonly Event[]; reviews: readonly Review[] },
  event: Event | undefined,
  itemId?: string,
  alreadyQueued = false,
): "paused" | "obsolete" | undefined {
  if (!event || !itemId) return;
  const p = event.payload as Record<string, unknown> | null;
  if (event.type === "review_submitted") {
    if (p?.review_limit_wait === true) return "obsolete";
    if (typeof p?.delivery_id !== "string") return;
    const groups = state.decisions.filter(
      (q) =>
        q.review_limit_group?.delivery_id === p.delivery_id &&
        q.status !== "withdrawn",
    );
    if (!groups.length) return;
    const target = state.deliveries.find((d) => d.id === p.delivery_id);
    if (
      !target ||
      target.work_item_id !== itemId ||
      target.status !== "rejected" ||
      groups.some(
        (q) => q.review_limit_group?.target_sha !== target.subject.value,
      ) ||
      state.deliveries.some((d) => d.supersedes === target.id)
    )
      return "obsolete";
    if (pendingSharedReview(groups, target.id)) return "paused";
    // A resolution replaces older notices. A Run that was already queued can
    // still serve the same repair, except when a strategy changed that task.
    if (
      groups.some(
        (q) =>
          (!alreadyQueued || q.resolution?.option !== "raise_limit") &&
          eventsForDecision(state.events, q.id).some(
            (e) => e.type === "decision_resolved" && e.seq > event.seq,
          ),
      )
    )
      return "obsolete";
    return;
  }
  if (event.type !== "decision_resolved") return;
  const q = state.decisions.find((q) => q.id === p?.decision_id);
  if (!q?.review_limit_group) return;
  if (p?.rework_work_item_id === itemId) {
    if (pendingSharedReview(state.decisions, q.review_limit_group.delivery_id))
      return "paused";
    return sharedReworkItem(state, q)?.id === itemId ? undefined : "obsolete";
  }
  const item = state.work_items.find((w) => w.id === itemId);
  return item &&
    Array.isArray(p?.resume_work_items) &&
    p.resume_work_items.includes(item.id) &&
    verificationTarget(item, state)
    ? undefined
    : "obsolete";
}

export function reviewWakeBlocked(
  ...args: Parameters<typeof reviewWakeDisposition>
) {
  return reviewWakeDisposition(...args) !== undefined;
}

/** An unstarted Run retains the review target of its original bell, even after recovery. */
export function reviewRunWakeDisposition(
  state: CommandState,
  owner: Assignment,
  run: Run,
) {
  if (owner.scope !== "work_item" || run.started_at) return;
  return reviewWakeDisposition(
    state,
    originalRunTrigger(state, run),
    owner.work_item_id,
    true,
  );
}

/** If the failed first send is still awaiting its retry/ack, that Run owns the
 * continuation. Do not also publish a second wake for the resolution. */
export function dispatchedRepair(
  state: CommandState,
  producer: WorkItem,
  deliveryId: string,
) {
  return state.runs.find((run) => {
    if (
      run.assignment_id !== producer.assignment_id ||
      run.kind !== "rework" ||
      run.status !== "dispatched" ||
      run.started_at ||
      run.inactivity_stop ||
      run.dispatch_stop
    )
      return false;
    const e = originalRunTrigger(state, run);
    if (!e || reviewWakeDisposition(state, e, producer.id, true)) return false;
    const p = e.payload as Record<string, unknown> | null;
    return (
      (e.type === "review_submitted" && p?.delivery_id === deliveryId) ||
      (e.type === "decision_resolved" &&
        p?.rework_work_item_id === producer.id &&
        state.decisions.find((q) => q.id === p.decision_id)?.review_limit_group
          ?.delivery_id === deliveryId)
    );
  });
}
