import type { CommandState } from "./commands/core.js";
import { mergeQueue } from "./commands/merge-batch.js";
import { mergeWindowHold } from "./commands/merge-window.js";
import type { Card, Delivery, MergeStage, WorkItem } from "./entities.js";
import type { CardId } from "./ids.js";
import {
  batchQueueWait,
  mergeBatches,
  passedCardCheck,
} from "./merge-batch.js";

// C-648: immutable collections (see event-index.ts), so one pass per snapshot
// replaces a deliveries × work items scan for every card.
const completions = new WeakMap<
  readonly Delivery[],
  WeakMap<readonly WorkItem[], ReadonlyMap<CardId, Delivery>>
>();
/** Same answer as filtering open completions of the card, sorting by number and taking the last. */
function latestCompletion(state: CommandState, card: CardId) {
  let byItems = completions.get(state.deliveries);
  if (!byItems) {
    byItems = new WeakMap();
    completions.set(state.deliveries, byItems);
  }
  let latest = byItems.get(state.work_items);
  if (!latest) {
    const owners = new Map<string, Set<CardId>>();
    for (const w of state.work_items) {
      const cards = owners.get(w.id);
      if (cards) cards.add(w.card_id);
      else owners.set(w.id, new Set([w.card_id]));
    }
    const map = new Map<CardId, Delivery>();
    for (const v of state.deliveries) {
      if (v.kind !== "card_completion" || v.status === "superseded") continue;
      for (const owner of owners.get(v.work_item_id) ?? []) {
        const previous = map.get(owner);
        // A stable ascending sort keeps the later of equal numbers last.
        if (!previous || Number(v.id.slice(2)) >= Number(previous.id.slice(2)))
          map.set(owner, v);
      }
    }
    latest = map;
    byItems.set(state.work_items, latest);
  }
  return latest.get(card);
}

export function mergeStage(
  state: CommandState,
  card: Card,
): MergeStage | undefined {
  const completion = latestCompletion(state, card.id);
  const batches = mergeBatches(state.events).filter((b) =>
    b.members.some(
      (m) =>
        m.card_id === card.id &&
        (card.status === "done" || m.completion_id === completion?.id),
    ),
  );
  const published = batches.findLast((b) => b.status === "published");
  const batch =
    published ??
    batches.findLast((b) => b.purpose === "main" && b.status !== "aborted");
  const pass =
    completion && passedCardCheck(state.events, card.id, completion.id);
  const wait = batch && batchQueueWait(state.events, batch);
  const detail = batch
    ? {
        batch_id: batch.id,
        peers: batch.members.map((m) => m.card_id),
        color: Number(batch.id.slice(3)) % 4,
        ...(batch.check
          ? {
              batch_check: wait
                ? { ...batch.check, queue_wait: wait }
                : batch.check,
            }
          : {}),
        ...(pass ? { card_check: pass } : {}),
      }
    : {};
  if (published && card.status === "done")
    return { ...detail, stage: "merged_in_batch" };
  if (card.status !== "awaiting_merge") return undefined;
  if (batch && !["published", "aborted", "resolved"].includes(batch.status))
    return {
      ...detail,
      stage: batch.status === "bisecting" ? "bisecting" : "batch_checking",
    };
  if (
    batch?.culprit === card.id &&
    !mergeQueue(state).some((q) => q.plan.card_id === card.id)
  )
    return { ...detail, stage: "culprit" };
  const protecting = mergeWindowHold(state, card.id);
  if (protecting)
    return {
      stage: "held_by_window",
      protecting_card_id: protecting.card_id,
      protecting_files: protecting.files,
      protecting_card_held: protecting.held,
      protecting_expires_at: protecting.expires_at,
      ...(protecting.since ? { held_since: protecting.since } : {}),
      ...(protecting.release_at ? { release_at: protecting.release_at } : {}),
    };
  const position = mergeQueue(state).findIndex(
    (q) => q.plan.card_id === card.id,
  );
  if (position >= 0)
    return {
      stage: "queued",
      position: position + 1,
      ...(pass ? { card_check: pass } : {}),
    };
  return state.project_settings?.merge_queue
    ? { stage: "awaiting_confirmation", ...(pass ? { card_check: pass } : {}) }
    : undefined;
}
