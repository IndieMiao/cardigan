import type { Card, Delivery } from "../entities.js";
import { transition } from "../transitions.js";
import { type CommandDraft, unwrap } from "./core.js";

/** Keep version invalidation and its pending merge confirmations in one effect. */
export function supersedeDelivery(
  d: CommandDraft,
  card: Card,
  delivery: Delivery,
): void {
  d.put("deliveries", {
    ...delivery,
    status: unwrap(transition("delivery", delivery.status, "supersede")),
  });
  for (const q of d.list("decisions")) {
    if (
      q.trigger !== "accepted_delivery_rework" ||
      q.rework_target?.delivery_id !== delivery.id ||
      !["open", "snoozed"].includes(q.status)
    )
      continue;
    supersedeReworkRequest(d, card, q.id);
  }
  if (delivery.kind !== "card_completion") return;
  for (const decision of d.list("decisions")) {
    if (
      decision.trigger !== "merge_confirmation" ||
      decision.kind !== "approve" ||
      !("delivery_id" in decision.target) ||
      decision.target.delivery_id !== delivery.id ||
      !["open", "snoozed"].includes(decision.status)
    )
      continue;
    d.put("decisions", {
      ...decision,
      status: unwrap(transition("decision", decision.status, "supersede")),
    });
    d.emit(
      "decision_superseded",
      card.id,
      {
        decision_id: decision.id,
        completion_id: delivery.id,
        reason: "completion_superseded",
      },
      {
        type: "system",
        author: "system",
        decision_id: decision.id,
        delivery_id: delivery.id,
        body: `完成申请 ${delivery.id} 已作废，合并确认 ${decision.key} 自动标记为已被取代。`,
      },
    );
  }
}

/** A stale rework question must not keep blocking its replacement. */
export function supersedeReworkRequest(
  d: CommandDraft,
  card: Card,
  id: import("../ids.js").DecisionId,
) {
  const q = d.get("decisions", id);
  d.put("decisions", {
    ...q,
    status: unwrap(transition("decision", q.status, "supersede")),
  });
  d.emit(
    "decision_superseded",
    card.id,
    { decision_id: q.id, reason: "rework_target_superseded" },
    {
      type: "system",
      author: "system",
      decision_id: q.id,
      body: `正式返工请求 ${q.id} 的依据已被取代，旧请求已作废。`,
    },
  );
}
