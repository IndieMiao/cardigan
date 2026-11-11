import type { Assignment, Delivery, WorkItem } from "./entities.js";

/** Verification Runs need a current target, regardless of their trigger or role. */
export function hasRunTarget(
  assignment: Assignment,
  state: {
    readonly work_items: readonly WorkItem[];
    readonly deliveries: readonly Delivery[];
  },
): boolean {
  if (assignment.scope !== "work_item") return true;
  const item = state.work_items.find((w) => w.id === assignment.work_item_id);
  if (!item) return false;
  if (item.kind !== "verify") return true;
  return state.deliveries.some(
    (delivery) =>
      delivery.status !== "superseded" &&
      state.work_items.some(
        (w) => w.id === delivery.work_item_id && w.card_id === item.card_id,
      ) &&
      (item.target_work_item_id
        ? delivery.work_item_id === item.target_work_item_id &&
          delivery.kind !== "card_completion"
        : delivery.kind === "card_completion" &&
          delivery.requested_verifiers.includes(item.id)),
  );
}
