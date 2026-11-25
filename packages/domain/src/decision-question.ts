import type { Decision, Delivery, Event, WorkItem } from "./entities.js";

/**
 * C-619: while a verifier waits on a review-limit decision, PM can ask it a
 * question bound to that decision (confirm a direction, add an opinion). The
 * verifier may answer with comments; the wait, its budget and every formal
 * write (review verdict, decision state, merge) stay closed.
 */
export type DecisionQuestion = {
  readonly assignment_id: string;
  /** The verifier's latest live delivery when asked; absent when it had none. */
  readonly delivery_id?: string;
  readonly target_sha?: string;
};

const PENDING = new Set<Decision["status"]>(["open", "snoozed", "provisional"]);

/** The pending review-limit decision that holds this verifier, if it is `decisionId`. */
export function heldByReviewDecision(
  decisions: readonly Decision[],
  item: WorkItem,
  decisionId: string,
): Decision | undefined {
  if (item.kind !== "verify" || item.status !== "waiting_decision") return;
  return decisions.find(
    (q) =>
      q.id === decisionId &&
      q.card_id === item.card_id &&
      q.trigger === "review_limit" &&
      PENDING.has(q.status) &&
      !q.superseded_by &&
      q.affected_work_items.includes(item.id),
  );
}

/** The newest delivery this verifier would review, reviewed or not. */
export function verifierDelivery(
  item: WorkItem,
  deliveries: readonly Delivery[],
): Delivery | undefined {
  if (item.kind !== "verify") return;
  const superseded = new Set(
    deliveries.flatMap((v) => (v.supersedes ? [v.supersedes] : [])),
  );
  return deliveries
    .filter(
      (v) =>
        v.status !== "superseded" &&
        !superseded.has(v.id) &&
        (item.target_work_item_id
          ? v.work_item_id === item.target_work_item_id &&
            v.kind !== "card_completion"
          : v.kind === "card_completion" &&
            v.requested_verifiers.includes(item.id)),
    )
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
    .at(-1);
}

/** Version binding recorded on the instruction. */
export function decisionQuestionBinding(
  item: WorkItem,
  deliveries: readonly Delivery[],
): DecisionQuestion | undefined {
  if (!item.assignment_id) return;
  const target = verifierDelivery(item, deliveries);
  return {
    assignment_id: item.assignment_id,
    ...(target
      ? { delivery_id: target.id, target_sha: target.subject.value }
      : {}),
  };
}

export function decisionQuestionPayload(event?: Event) {
  if (event?.type !== "instruction_issued") return;
  const p = event.payload as {
    work_item_id?: unknown;
    decision_id?: unknown;
    decision_question?: Partial<DecisionQuestion> | null;
  } | null;
  if (
    !p?.decision_question ||
    typeof p.decision_question !== "object" ||
    typeof p.decision_id !== "string" ||
    typeof p.work_item_id !== "string"
  )
    return;
  return {
    work_item_id: p.work_item_id,
    decision_id: p.decision_id,
    question: p.decision_question,
  };
}

/**
 * Re-read at routing, queueing and dispatch: only the related verifier, while
 * it is still held by the same pending decision for the same delivery version
 * and Assignment, may run a discussion for this question.
 */
export function decisionQuestionCurrent(
  item: WorkItem,
  event: Event | undefined,
  state: {
    readonly decisions: readonly Decision[];
    readonly deliveries: readonly Delivery[];
  },
): boolean {
  const p = decisionQuestionPayload(event);
  if (!p || event?.card_id !== item.card_id || p.work_item_id !== item.id)
    return false;
  if (!heldByReviewDecision(state.decisions, item, p.decision_id)) return false;
  const now = decisionQuestionBinding(item, state.deliveries);
  return (
    !!now &&
    now.assignment_id === p.question.assignment_id &&
    now.delivery_id === p.question.delivery_id &&
    now.target_sha === p.question.target_sha
  );
}
