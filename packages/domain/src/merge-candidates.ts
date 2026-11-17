import type { Card, Delivery, WorkItem } from "./entities.js";

const newest = <T extends { readonly id: string }>(values: readonly T[]) =>
  [...values].sort(
    (a, b) => Number(b.id.replace(/\D/g, "")) - Number(a.id.replace(/\D/g, "")),
  )[0];

/** The current accepted Git products that actually require publication. */
export function cardMergeCandidates(
  state: {
    readonly work_items: readonly WorkItem[];
    readonly deliveries: readonly Delivery[];
  },
  card: Card,
) {
  return state.work_items
    .filter((w) => w.card_id === card.id && w.kind === "produce")
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
    .flatMap((w) => {
      const delivery = newest(
        state.deliveries.filter(
          (v) =>
            v.work_item_id === w.id &&
            v.kind !== "card_completion" &&
            v.status !== "superseded",
        ),
      );
      if (
        delivery?.status !== "accepted" ||
        delivery.subject.kind !== "git_head"
      )
        return [];
      return [
        {
          delivery_id: delivery.id,
          work_item_id: w.id,
          sha: delivery.subject.value,
        },
      ];
    });
}
