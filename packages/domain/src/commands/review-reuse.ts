import { deriveCardStatus, isReviewStale } from "../derived.js";
import type { Delivery, Review, WorkItem } from "../entities.js";
import type { AssignmentId } from "../ids.js";
import { transition } from "../transitions.js";
import { type CommandDraft, unwrap } from "./core.js";
import { supersedeDelivery } from "./delivery-invalidation.js";
import { employeeConflicts } from "./employee-assignment.js";
import { syncRiskTagMerge } from "./merge.js";

/** Canonical comparison of evidence, independent of JSON property order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Only commit evidence returned by the trusted DeliveryVerifier counts. */
export function deliveryTree(delivery: Pick<Delivery, "subject" | "evidence">) {
  if (delivery.subject.kind !== "git_head") return undefined;
  const sha = delivery.subject.value;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sha)) return undefined;
  const trees = delivery.evidence.flatMap((e) => {
    if (
      e.kind !== "commit" ||
      !e.details ||
      typeof e.details !== "object" ||
      Array.isArray(e.details)
    )
      return [];
    if (!("sha" in e.details) || !("tree_sha" in e.details)) return [];
    const { sha: verifiedSha, tree_sha: tree } = e.details;
    return verifiedSha === sha &&
      typeof tree === "string" &&
      tree.length === sha.length &&
      /^[a-f0-9]+$/u.test(tree)
      ? [tree]
      : [];
  });
  return trees.length === 1 ? trees[0] : undefined;
}

/** Requirements and current/historical identity proof, not runtime or review progress. */
export function reviewReuseContext(
  d: CommandDraft,
  delivery: Delivery,
  item: WorkItem,
  assignmentId: AssignmentId,
): string | undefined {
  const producer = d.work(delivery.work_item_id);
  const card = d.card(producer.card_id);
  const owner = d.list("assignments").find((a) => a.id === assignmentId);
  if (
    owner?.scope !== "work_item" ||
    owner.work_item_id !== item.id ||
    item.assignment_id !== owner.id ||
    item.card_id !== card.id ||
    item.kind !== "verify" ||
    item.status === "cancelled" ||
    item.replaced_by_work_item_id ||
    owner.id === producer.assignment_id ||
    (owner.employee_id && employeeConflicts(d, item, owner.employee_id))
  )
    return undefined;
  const items = d.list("work_items").filter((w) => w.card_id === card.id);
  const identities = new Set([
    producer.id,
    item.id,
    ...items
      .filter(
        (w) =>
          w.kind === "verify" &&
          (item.role_id === "independent_reviewer" ||
            w.role_id === "independent_reviewer"),
      )
      .map((w) => w.id),
  ]);
  return canonical({
    version: 1,
    review_epoch: [...d.state.events, ...d.events]
      .filter(
        (e) =>
          e.card_id === card.id &&
          ["merge_conflicted", "merge_changes_requested"].includes(e.type),
      )
      .at(-1)?.id,
    card: {
      id: card.id,
      goal: card.goal,
      acceptance_criteria: card.acceptance_criteria,
      out_of_scope: card.out_of_scope,
      risk_tags: [...(card.risk_tags ?? [])].sort(),
      template: card.template,
      template_version: card.template_version,
    },
    requirements: items
      .filter((w) => w.required || w.id === item.id || w.id === producer.id)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((w) => ({
        id: w.id,
        kind: w.kind,
        role_id: w.role_id,
        required: w.required,
        target: w.kind === "verify" ? w.target_work_item_id : undefined,
        completion_criteria: w.completion_criteria,
        depends_on: w.depends_on,
        cancelled: w.status === "cancelled",
        replaced: w.replaced_by_work_item_id,
      })),
    assignments: d
      .list("assignments")
      .filter((a) => a.scope === "work_item" && identities.has(a.work_item_id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a) => ({
        id: a.id,
        work_item_id: a.scope === "work_item" ? a.work_item_id : undefined,
        employee_id: a.employee_id,
        role_id: a.role_id,
        role_version: a.role_version,
      })),
    // A completion's underlying accepted set is part of what PM actually approved.
    products:
      delivery.kind === "card_completion"
        ? d
            .list("deliveries")
            .filter(
              (v) =>
                v.kind !== "card_completion" &&
                v.status !== "superseded" &&
                items.some((w) => w.id === v.work_item_id),
            )
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((v) => ({ id: v.id, subject: v.subject, status: v.status }))
        : undefined,
  });
}

/** Called on control-plane mutations; reverting a change cannot revive old proof. */
export function invalidateReviewReuse(d: CommandDraft): void {
  const affected = new Set(
    d.changes.flatMap((c) => {
      if (c.collection === "cards") return [c.entity.id];
      if (c.collection === "work_items") return [c.entity.card_id];
      if (
        c.collection === "deliveries" ||
        (c.collection === "assignments" && c.entity.scope === "work_item")
      )
        return c.entity.work_item_id
          ? [d.get("work_items", c.entity.work_item_id).card_id]
          : [];
      return [];
    }),
  );
  if (!affected.size) return;
  for (const review of d.list("reviews")) {
    if (!review.reuse_basis || review.reuse_invalidated_at) continue;
    if (!affected.has(d.get("work_items", review.work_item_id).card_id))
      continue;
    const delivery = d.get("deliveries", review.delivery_id);
    const current = reviewReuseContext(
      d,
      delivery,
      d.work(review.work_item_id),
      review.reuse_basis.assignment_id,
    );
    if (current === review.reuse_basis.context) continue;
    d.put("reviews", { ...review, reuse_invalidated_at: d.now });
    const card = d.card(d.work(review.work_item_id).card_id);
    const reused = d
      .list("deliveries")
      .filter(
        (v) =>
          v.status !== "superseded" && v.reused_reviews?.includes(review.id),
      );
    if (!reused.length || ["done", "cancelled"].includes(card.status)) continue;
    if (card.pre_merge_checks)
      d.put("cards", {
        ...card,
        pre_merge_checks: card.pre_merge_checks.map((c) =>
          c.reused_from === review.id ||
          c.checked_versions?.some((v) => v.reused_from === review.id)
            ? {
                ...c,
                status: "pending" as const,
                note: `沿用的审核 ${review.id} 已失效`,
              }
            : c,
        ),
      });
    // An invalid binding must return to a runnable workflow, including when
    // automatic verifier assignment changed the proof after completion checks.
    const products = reused.filter((v) => v.kind !== "card_completion");
    const targets = d
      .list("deliveries")
      .filter(
        (v) =>
          v.status !== "superseded" &&
          (reused.some((r) => r.id === v.id) ||
            (products.length > 0 &&
              v.kind === "card_completion" &&
              d.work(v.work_item_id).card_id === card.id)),
      );
    for (const target of targets) {
      supersedeDelivery(d, d.card(card.id), target);
      for (const id of target.requested_verifiers) {
        const item = d.work(id);
        if (["ready", "in_progress", "passed", "failed"].includes(item.status))
          d.put("work_items", d.move(item, "target_withdrawn"));
      }
      if (target.kind !== "card_completion") {
        const item = d.work(target.work_item_id);
        if (item.status === "accepted" || item.status === "delivered")
          d.put(
            "work_items",
            d.move(
              item,
              item.status === "accepted"
                ? "request_changes"
                : "review_rejected",
            ),
          );
      }
      for (const decision of d.list("decisions")) {
        if (
          (decision.trigger === "merge_confirmation" ||
            decision.trigger === "completion_review") &&
          decision.kind === "approve" &&
          "delivery_id" in decision.target &&
          decision.target.delivery_id === target.id &&
          ["open", "snoozed", "resolved", "provisional"].includes(
            decision.status,
          )
        )
          d.put("decisions", {
            ...decision,
            status: unwrap(
              transition(
                "decision",
                decision.status,
                decision.status === "provisional" ? "revoke" : "supersede",
              ),
            ),
          });
      }
    }
    const currentCard = d.card(card.id);
    if (!["done", "cancelled"].includes(currentCard.status))
      d.put("cards", {
        ...currentCard,
        status: deriveCardStatus(
          currentCard.status === "awaiting_merge"
            ? unwrap(transition("card", currentCard.status, "request_changes"))
            : currentCard.status,
          d.list("work_items").filter((w) => w.card_id === card.id),
        ),
      });
    d.emit(
      "review_reuse_invalidated",
      card.id,
      {
        review_id: review.id,
        delivery_ids: reused.map((v) => v.id),
        work_item_ids: [...new Set(reused.map((v) => v.work_item_id))],
      },
      {
        type: "system",
        author: "system",
        work_item_id: review.work_item_id,
        body: `审核 ${review.id} 的沿用资格已失效，须重新交付并审核。`,
        refs: [{ kind: "review", id: review.id }],
      },
    );
    syncRiskTagMerge(d, d.card(card.id));
  }
}

export function reusableReviews(
  d: CommandDraft,
  previous: Delivery | undefined,
  next: Delivery,
): Review[] {
  if (
    !previous ||
    previous.status === "superseded" ||
    previous.status === "rejected" ||
    previous.work_item_id !== next.work_item_id ||
    previous.kind !== next.kind ||
    previous.subject.value !== next.subject.value ||
    !deliveryTree(previous) ||
    deliveryTree(previous) !== deliveryTree(next)
  )
    return [];
  const contents = (v: Delivery) => ({
    attachments: v.attachments,
    known_gaps: v.known_gaps,
    test_results: v.test_results,
    ...(v.kind === "card_completion"
      ? {
          summary: v.summary,
          plain_summary: v.plain_summary,
          requested_verifiers: [...v.requested_verifiers].sort(),
          evidence: v.evidence.filter((e) => e.kind !== "commit"),
        }
      : {}),
  });
  if (canonical(contents(previous)) !== canonical(contents(next))) return [];
  return next.requested_verifiers.flatMap((id) => {
    const item = d.work(id);
    if (item.status !== "passed") return [];
    const review = d
      .list("reviews")
      .filter((r) => r.work_item_id === id)
      .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
    if (
      review?.verdict !== "pass" ||
      review.reuse_invalidated_at ||
      !review.reuse_basis ||
      isReviewStale(review, previous) ||
      review.reuse_basis.context !==
        reviewReuseContext(d, next, item, review.reuse_basis.assignment_id)
    )
      return [];
    return [review];
  });
}
