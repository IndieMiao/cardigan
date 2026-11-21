import type { Event, MergeCheckView } from "../entities.js";
import { eventsForCompletion } from "../event-index.js";
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
  const history = eventsForCompletion(events, completion);
  const event = history
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
  const check = event.payload as unknown as MergeCheckView;
  const waiting =
    check.status === "queued"
      ? history
          .filter(
            (e) =>
              e.actor.kind === "system" &&
              e.card_id === card &&
              e.type === "merge_check_waiting" &&
              e.seq > event.seq &&
              (e.payload as { attempt_id?: string }).attempt_id ===
                check.attempt_id &&
              (e.payload as { completion_id?: string }).completion_id ===
                completion,
          )
          .sort((a, b) => b.seq - a.seq)[0]
      : undefined;
  return {
    ...(waiting
      ? {
          queue_wait: {
            reason: (waiting.payload as { reason: string }).reason,
            queued_at: (waiting.payload as { queued_at: string }).queued_at,
          },
        }
      : {}),
    ...(event.payload as unknown as MergeCheckView),
    updated_at: event.created_at,
  };
}
