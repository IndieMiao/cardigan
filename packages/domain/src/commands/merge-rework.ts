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
  supersedeDelivery(d, card, completion);
  for (const id of completion.requested_verifiers)
    d.put("work_items", d.move(d.work(id), "target_withdrawn"));
  d.put("cards", next);
  return next;
}
