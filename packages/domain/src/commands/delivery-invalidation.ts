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
