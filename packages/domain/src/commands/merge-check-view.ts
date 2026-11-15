import type { Event, MergeCheckView } from "../entities.js";
import type { CardId, DeliveryId } from "../ids.js";
export const MERGE_CHECK_EVENTS = [
  "merge_check_queued",
  "merge_check_started",
  "merge_check_finished",
  "merge_check_requeued",
];
export function latestMergeCheck(
  events: readonly Event[],
  card: CardId,
  completion: DeliveryId,
  tree?: string,
): MergeCheckView | undefined {
  const event = events
    .filter((e) => {
      const p = e.payload as Partial<MergeCheckView> | null;
      return (
        e.card_id === card &&
        MERGE_CHECK_EVENTS.includes(e.type) &&
        p?.completion_id === completion &&
        (!tree || p.tree_sha === tree)
      );
    })
    .sort((a, b) => b.seq - a.seq)[0];
  if (!event) return undefined;
  return {
    ...(event.payload as unknown as MergeCheckView),
    updated_at: event.created_at,
  };
}
