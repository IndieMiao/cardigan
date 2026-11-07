import type {
  Attachment,
  CardView,
  Decision,
  Delivery,
  Review,
  ReviewIssue,
  WorkItem,
} from "./entities.js";
import type { ApprovalStatus, CardStatus } from "./states.js";

export function deriveReview(
  issues: readonly ReviewIssue[],
  recheck_required = false,
): Pick<Review, "issues" | "verdict" | "blocking"> {
  const normalized = issues.map(
    (issue): ReviewIssue =>
      issue.severity === "critical" && !issue.proof?.trim()
        ? { ...issue, severity: "major" }
        : { ...issue },
  );
  const blocking = normalized.some(
    (issue) => issue.must_fix && !issue.pre_existing,
  );
  return {
    issues: normalized,
    verdict: blocking ? "reject" : recheck_required ? "conditional" : "pass",
    blocking,
  };
}

// Pass the current delivery; a new ID invalidates reviews even if the SHA stayed the same.
export function isReviewStale(
  review: Pick<Review, "delivery_id" | "target_sha">,
  current: Pick<Delivery, "id" | "subject" | "status">,
): boolean {
  return (
    review.delivery_id !== current.id ||
    review.target_sha !== current.subject.value ||
    current.status === "superseded"
  );
}

export function deriveAttachmentApproval(
  attachment: Pick<Attachment, "basis">,
  decisions: readonly Pick<Decision, "key" | "status">[],
): ApprovalStatus {
  const status =
    attachment.basis === undefined
      ? undefined
      : decisions.find((decision) => decision.key === attachment.basis)?.status;
  if (status === "resolved") return "approved";
  return status === "revoked" ||
    status === "withdrawn" ||
    status === "superseded"
    ? "revoked"
    : "pending";
}

// Inputs belong to one card/project. V-n is project-monotonic; input order is irrelevant.
type MatrixDelivery = Pick<
  Delivery,
  | "id"
  | "subject"
  | "status"
  | "supersedes"
  | "work_item_id"
  | "kind"
  | "requested_verifiers"
>;
type MatrixWorkItem = Pick<WorkItem, "id" | "kind"> & {
  readonly target_work_item_id?: WorkItem["target_work_item_id"];
};
type MatrixReview = Pick<
  Review,
  "id" | "delivery_id" | "work_item_id" | "target_sha" | "verdict"
>;
/**
 * Only the verifiers that review this delivery (§4.4, M5.S S16): a completion
 * request asks for the PM acceptance item and nothing else, while a produce
 * delivery is reviewed by the verification items that target it.
 */
function verifiesDelivery(
  item: MatrixWorkItem,
  delivery: MatrixDelivery,
): boolean {
  return delivery.kind === "card_completion"
    ? delivery.requested_verifiers.includes(item.id)
    : item.target_work_item_id === delivery.work_item_id;
}
export function deriveReviewMatrix(
  deliveries: readonly MatrixDelivery[],
  workItems: readonly MatrixWorkItem[],
  reviews: readonly MatrixReview[],
): CardView["review_matrix"] {
  return deliveries.flatMap((delivery) =>
    workItems
      .filter(
        (item) => item.kind === "verify" && verifiesDelivery(item, delivery),
      )
      .map((item) => {
        const superseded = deliveries.some(
          (next) => next.supersedes === delivery.id,
        );
        const latest = reviews
          .filter(
            (review) =>
              !superseded &&
              review.work_item_id === item.id &&
              !isReviewStale(review, delivery),
          )
          .reduce<MatrixReview | undefined>(
            (last, review) =>
              !last || Number(review.id.slice(2)) > Number(last.id.slice(2))
                ? review
                : last,
            undefined,
          );
        return {
          delivery_id: delivery.id,
          work_item_id: item.id,
          target_sha: delivery.subject.value,
          verdict: latest?.verdict ?? null,
          ...(latest ? { review_id: latest.id } : {}),
        };
      }),
  );
}

// Planning and terminal states are never inferred from an empty or completed work list.
export function deriveCardStatus(
  current: CardStatus,
  workItems: readonly Pick<WorkItem, "kind" | "status" | "required">[],
  completion?: Pick<Delivery, "kind" | "status">,
): CardStatus {
  if (
    current === "done" ||
    current === "cancelled" ||
    current === "awaiting_merge"
  )
    return current;
  if (
    completion?.kind === "card_completion" &&
    completion.status === "submitted"
  )
    return "review";
  if (
    completion?.kind === "card_completion" &&
    completion.status === "rejected"
  )
    return "in_progress";
  const started = workItems.some(
    (item) => item.status !== "todo" && item.status !== "ready",
  );
  if (!started && (current === "backlog" || current === "todo")) return current;
  const required = workItems.filter((item) => item.required);
  const produces = required.filter((item) => item.kind === "produce");
  return produces.length > 0 &&
    produces.every(
      (item) => item.status === "delivered" || item.status === "accepted",
    ) &&
    !required.some((item) => item.kind === "verify" && item.status === "failed")
    ? "review"
    : "in_progress";
}
