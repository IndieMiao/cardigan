import { deriveCardStatus } from "../derived.js";
import type { Card, Delivery } from "../entities.js";
import { transition } from "../transitions.js";
import { systemCompletionCurrent } from "./completion-binding.js";
import { type CommandDraft, unwrap } from "./core.js";
import { supersedeDelivery } from "./delivery-invalidation.js";

/** A source change revokes the entire generated snapshot, including pending human acceptance. */
export function invalidateSystemCompletions(
  d: CommandDraft,
  cardId?: import("../ids.js").CardId,
) {
  const affected = new Set(
    d.changes.flatMap((c) => {
      if (c.collection === "cards") return [c.entity.id];
      if (c.collection === "work_items") return [c.entity.card_id];
      if (c.collection === "deliveries" || c.collection === "reviews")
        return [d.get("work_items", c.entity.work_item_id).card_id];
      if (c.collection === "assignments" && c.entity.scope === "work_item")
        return [d.get("work_items", c.entity.work_item_id).card_id];
      return [];
    }),
  );
  if (cardId) affected.add(cardId);
  for (const target of d.list("deliveries")) {
    if (!target.system_completion || target.status === "superseded") continue;
    const card = d.get(
      "cards",
      d.get("work_items", target.work_item_id).card_id,
    );
    if (
      !affected.has(card.id) ||
      ["done", "cancelled"].includes(card.status) ||
      systemCompletionCurrent(d, card, target)
    )
      continue;
    invalidateCompletion(d, card, target);
  }
}

/** Revoke a completion and its downstream authority in the same transaction. */
export function invalidateCompletion(
  d: CommandDraft,
  card: Card,
  target: Delivery,
  reason:
    | "source_changed"
    | "required_verifier_added"
    | "independent_review_recheck" = "source_changed",
) {
  supersedeDelivery(d, card, target);
  for (const id of target.requested_verifiers) {
    const item = d.get("work_items", id);
    if (["ready", "in_progress", "passed", "failed"].includes(item.status))
      d.put("work_items", d.move(item, "target_withdrawn"));
  }
  for (const q of d.list("decisions"))
    if (
      (q.trigger === "merge_confirmation" ||
        q.trigger === "completion_review") &&
      q.kind === "approve" &&
      "delivery_id" in q.target &&
      q.target.delivery_id === target.id &&
      ["open", "snoozed", "resolved", "provisional"].includes(q.status)
    )
      d.put("decisions", {
        ...q,
        status: unwrap(
          transition(
            "decision",
            q.status,
            q.status === "provisional" ? "revoke" : "supersede",
          ),
        ),
      });
  const current = d.get("cards", card.id);
  d.put("cards", {
    ...current,
    status: deriveCardStatus(
      current.status === "awaiting_merge"
        ? unwrap(transition("card", current.status, "request_changes"))
        : current.status,
      d.list("work_items").filter((w) => w.card_id === card.id),
    ),
  });
  d.emit(
    reason === "source_changed"
      ? "system_completion_invalidated"
      : "completion_invalidated",
    card.id,
    reason === "source_changed"
      ? { rule: "flow-v2/B3a", completion_id: target.id }
      : { reason, completion_id: target.id },
    {
      type: "system",
      author: "system",
      delivery_id: target.id,
      body:
        reason === "source_changed"
          ? "系统完成申请的产出或审核依据已变化，原申请和确认已作废。"
          : reason === "independent_review_recheck"
            ? "独立复核须对当前版本重新核对，原完成申请和确认已作废，复核通过后重新申请。"
            : "新增必需验证项，原完成申请和确认已作废，等待审核完成后重新申请。",
    },
  );
}
