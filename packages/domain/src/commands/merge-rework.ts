import type { Card, Delivery } from "../entities.js";
import type { WorkItemId } from "../ids.js";
import { transition } from "../transitions.js";
import { type CommandDraft, unwrap } from "./core.js";
import { supersedeDelivery } from "./delivery-invalidation.js";

/** Both a conflict and a human return invalidate the accepted completion. */
export function reopenMerge(
  d: CommandDraft,
  card: Card,
  completion: Delivery,
  work_item_id: WorkItemId,
  event: "merge_conflicted" | "request_changes",
) {
  const next = {
    ...card,
    status: unwrap(transition("card", card.status, event)),
  };
  d.put("work_items", d.move(d.work(work_item_id), event));
  supersedeCompletion(d, card, completion);
  d.put("cards", next);
  return next;
}

/** Shared completion invalidation for conflicts, A1 and explicit human rework. */
export function supersedeCompletion(
  d: CommandDraft,
  card: Card,
  completion: Delivery,
) {
  supersedeDelivery(d, card, completion);
  for (const id of completion.requested_verifiers) {
    const w = d.work(id);
    if (["ready", "in_progress", "passed", "failed"].includes(w.status))
      d.put("work_items", d.move(w, "target_withdrawn"));
  }
}
