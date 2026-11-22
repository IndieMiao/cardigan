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
import { eventsForDecision, eventsOfType } from "./event-index.js";
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

/** Only domain-issued, item-addressed instructions can start a discussion. A
 * proposal request must belong to the assigned strategy, not match prose. */
export function reviewDiscussionInstruction(item: WorkItem, event?: Event) {
  if (
    item.kind !== "verify" ||
    event?.type !== "instruction_issued" ||
    event.card_id !== item.card_id
  )
    return false;
  const p = event.payload as {
    work_item_id?: string;
    decision_id?: string;
  };
  return (
    p?.work_item_id === item.id &&
    (p.decision_id === undefined || p.decision_id === item.review_plan_target)
  );
}

/** Re-read at routing and launch: a durable notification is not permission to work. */
function reviewWakeDisposition(
  state: State & { events: readonly Event[]; reviews: readonly Review[] },
  event: Event | undefined,
  itemId?: string,
  alreadyQueued = false,
): "paused" | "obsolete" | undefined {
  if (!itemId) return;
  const verifier = state.work_items.find((w) => w.id === itemId);
  if (
    verifier?.kind === "verify" &&
    verifier.status === "waiting_decision" &&
    !reviewDiscussionInstruction(verifier, event)
  )
    return "paused";
  if (!event) return;
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
  if (!boundReceiptTargetCurrent(state, owner, run)) return "obsolete";
  return reviewWakeDisposition(
    state,
    originalRunTrigger(state, run),
    owner.work_item_id,
    true,
  );
}

/** A transport replay can follow run_started. Keep the original review target
 * authoritative even though ordinary Run-start guards no longer apply. */
export function reviewReceiptTargetCurrent(
  state: CommandState,
  owner: Assignment,
  run: Run,
) {
  return (
    boundReceiptTargetCurrent(state, owner, run) &&
    (owner.scope !== "work_item" ||
      !reviewWakeDisposition(
        state,
        originalRunTrigger(state, run),
        owner.work_item_id,
        true,
      ))
  );
}

function boundReceiptTargetCurrent(
  state: CommandState,
  owner: Assignment,
  run: Run,
) {
  const binding = run.bell_delivery?.review_target;
  if (binding) {
    const target = state.deliveries.find((d) => d.id === binding.delivery_id);
    if (
      !target ||
      target.work_item_id !== owner.work_item_id ||
      target.subject.value !== binding.target_sha ||
      target.status === "superseded" ||
      state.deliveries.some((d) => d.supersedes === target.id)
    )
      return false;
  }
  return true;
}

/** Bind a host withdrawal to the immutable trigger, not just the current SHA. */
export function repairWakeTarget(state: CommandState, run: Run) {
  if (run.kind !== "rework" || run.status !== "dispatched" || run.started_at)
    return;
  const e = originalRunTrigger(state, run);
  const p = e?.payload as Record<string, unknown> | null;
  const id =
    e?.type === "review_submitted"
      ? p?.delivery_id
      : e?.type === "decision_resolved" && p?.rework_work_item_id
        ? state.decisions.find((q) => q.id === p.decision_id)
            ?.review_limit_group?.delivery_id
        : undefined;
  return state.deliveries.find((d) => d.id === id);
}

/** Only a proven pre-send withdrawal can replace the missing first attempt.
 * In-flight, sent or failed attempts take precedence in the dispatcher. */
export function resumableReviewWithdrawal(
  state: CommandState,
  owner: Assignment,
  run: Run,
) {
  const target = repairWakeTarget(state, run);
  if (
    !target ||
    run.assignment_id !== owner.id ||
    owner.scope !== "work_item" ||
    target.work_item_id !== owner.work_item_id ||
    !state.decisions.some(
      (q) =>
        q.review_limit_group?.delivery_id === target.id &&
        q.status === "resolved" &&
        q.resolution?.option === "raise_limit" &&
        sharedReworkItem(state, q)?.id === target.work_item_id,
    ) ||
    reviewRunWakeDisposition(state, owner, run)
  )
    return false;
  return eventsOfType(state.events, "run_dispatch_deferred").some((e) => {
    const p = e.payload as Record<string, unknown> | null;
    return (
      e.actor.kind === "system" &&
      e.actor.project_id === state.project_id &&
      p?.reason === "shared_review_paused" &&
      p.run_id === run.id &&
      p.assignment_id === owner.id &&
      typeof p.attempt_id === "string" &&
      p.delivery_id === target.id &&
      p.target_sha === target.subject.value
    );
  });
}

/** An unstarted dispatched repair owns its send, resume, retry or ack. Keep one
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
