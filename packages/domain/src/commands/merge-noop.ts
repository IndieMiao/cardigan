import type { Event } from "../entities.js";
import { eventsForCompletion } from "../event-index.js";
import type { CardId, DeliveryId } from "../ids.js";

/**
 * C-777: the host-verified noop predicates, kept free of command imports so
 * merge blockers can read them without a cycle through `merge.ts`.
 */
export const readinessEvents = new Set([
  "merge_preparation_recorded",
  "merge_check_queued",
  "merge_check_started",
  "merge_check_finished",
  "merge_check_requeued",
]);

/** A host-verified noop makes the confirmation visible; it never authorizes publication. */
export function hasVerifiedMergeNoop(
  events: readonly Event[],
  card: CardId,
  completion: DeliveryId,
): boolean {
  const latest = eventsForCompletion(events, completion)
    .filter(
      (e) =>
        e.card_id === card &&
        readinessEvents.has(e.type) &&
        (e.payload as { completion_id?: string } | null)?.completion_id ===
          completion,
    )
    .sort((a, b) => b.seq - a.seq)[0];
  return (
    latest?.type === "merge_preparation_recorded" &&
    latest.actor.kind === "system" &&
    (latest.payload as { noop?: boolean }).noop === true
  );
}

const idleEvents = new Set([...readinessEvents, "merge_failed"]);

/**
 * C-777: merge work of this completion that will not ask for a check slot by
 * itself: a host-verified noop (no check is ever queued for it) or a recorded
 * merge failure not followed by a new check or preparation. Scheduling uses it
 * only to stop such work from holding capacity; it authorizes nothing.
 */
export function mergeAwaitsNoCheck(
  events: readonly Event[],
  card: CardId,
  completion: DeliveryId,
): boolean {
  if (hasVerifiedMergeNoop(events, card, completion)) return true;
  const latest = eventsForCompletion(events, completion)
    .filter(
      (e) =>
        e.card_id === card &&
        idleEvents.has(e.type) &&
        (e.payload as { completion_id?: string } | null)?.completion_id ===
          completion,
    )
    .sort((a, b) => b.seq - a.seq)[0];
  return latest?.type === "merge_failed" && latest.actor.kind === "system";
}
