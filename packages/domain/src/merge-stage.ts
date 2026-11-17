import type { CommandState } from "./commands/core.js";
import { mergeQueue } from "./commands/merge-batch.js";
import { heldByMergeWindow } from "./commands/merge-window.js";
import type { Card, MergeStage } from "./entities.js";
import { mergeBatches, passedCardCheck } from "./merge-batch.js";

export function mergeStage(
  state: CommandState,
  card: Card,
): MergeStage | undefined {
  const batches = mergeBatches(state.events).filter((b) =>
    b.members.some((m) => m.card_id === card.id),
  );
  const published = batches.findLast((b) => b.status === "published");
  const batch =
    published ??
    batches.findLast((b) => b.purpose === "main" && b.status !== "aborted");
  const completion = state.deliveries
    .filter(
      (v) =>
        v.kind === "card_completion" &&
        v.status !== "superseded" &&
        state.work_items.some(
          (w) => w.id === v.work_item_id && w.card_id === card.id,
        ),
    )
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
    .at(-1);
  const pass =
    completion && passedCardCheck(state.events, card.id, completion.id);
  const detail = batch
    ? {
        batch_id: batch.id,
        peers: batch.members.map((m) => m.card_id),
        color: Number(batch.id.slice(3)) % 4,
        ...(batch.check ? { batch_check: batch.check } : {}),
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
  const protecting = heldByMergeWindow(state, card.id);
  if (protecting)
    return { stage: "held_by_window", protecting_card_id: protecting };
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
