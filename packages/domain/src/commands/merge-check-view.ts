import type { Event, MergeCheckView } from "../entities.js";
import type { CardId, DeliveryId } from "../ids.js";
export const MERGE_CHECK_EVENTS = [
  "merge_check_queued",
  "merge_check_started",
  "merge_check_finished",
  "merge_check_requeued",
];
interface TargetChecks {
  // Empty tree selects the latest check irrespective of tree, as in the public query.
  byTree: Map<string, Event>;
  waits: Map<string | undefined, Event>;
}
const indexes = new WeakMap<readonly Event[], Map<string, TargetChecks>>();
const targetKey = (card: CardId, completion: DeliveryId) =>
  `${card}/${completion}`;
function keepLatest<K>(map: Map<K, Event>, key: K, event: Event) {
  const previous = map.get(key);
  if (!previous || event.seq > previous.seq) map.set(key, event);
}
/** Immutable history (as in event-index.ts): one pass across all streams per snapshot. */
function targetIndex(events: readonly Event[]) {
  const cached = indexes.get(events);
  if (cached) return cached;
  const targets = new Map<string, TargetChecks>();
  for (const e of events) {
    const waiting =
      e.type === "merge_check_waiting" && e.actor.kind === "system";
    if (!e.card_id || (!waiting && !MERGE_CHECK_EVENTS.includes(e.type)))
      continue;
    const p = e.payload as Partial<MergeCheckView> | null;
    if (!p?.completion_id) continue;
    const key = targetKey(e.card_id, p.completion_id);
    let target = targets.get(key);
    if (!target) {
      target = { byTree: new Map(), waits: new Map() };
      targets.set(key, target);
    }
    if (waiting) {
      keepLatest(target.waits, p.attempt_id, e);
    } else {
      keepLatest(target.byTree, "", e);
      if (p.tree_sha) keepLatest(target.byTree, p.tree_sha, e);
    }
  }
  indexes.set(events, targets);
  return targets;
}
export function latestMergeCheck(
  events: readonly Event[],
  card: CardId,
  completion: DeliveryId,
  tree?: string,
): MergeCheckView | undefined {
  const target = targetIndex(events).get(targetKey(card, completion));
  const event = target?.byTree.get(tree ?? "");
  if (!event) return undefined;
  const check = event.payload as unknown as MergeCheckView;
  const waiting =
    check.status === "queued" ? target?.waits.get(check.attempt_id) : undefined;
  return {
    ...(waiting && waiting.seq > event.seq
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
