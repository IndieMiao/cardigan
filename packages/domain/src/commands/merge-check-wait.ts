import type { Actor, MergeCheckView } from "../entities.js";
import type { CardId, MergeBatchId } from "../ids.js";
import { batchQueueWait, mergeBatches } from "../merge-batch.js";
import {
  attempt,
  type CommandPorts,
  type CommandState,
  command,
  text,
} from "./core.js";
import { latestMergeCheck } from "./merge-check-view.js";
import { mergeContext } from "./merge-context.js";

/** Host observation only; never updates the attempt's lifecycle or passing evidence. */
export function recordMergeCheckWait(
  state: CommandState,
  actor: Actor,
  p: {
    card_id: CardId;
    completion_id: MergeCheckView["completion_id"];
    attempt_id: string;
    reason: string;
    repository_retry_at?: string;
    batch_id?: MergeBatchId;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "record_merge_check_wait", ports, (d) => {
    d.projectAccess();
    text(p.reason, "reason");
    const context = attempt(() => mergeContext(state, p.card_id));
    if (!context.ok || context.value.target.id !== p.completion_id) return;
    const card = context.value.card;
    const batch =
      p.batch_id &&
      mergeBatches(state.events).find(
        (b) => b.id === p.batch_id && b.members.at(-1)?.card_id === p.card_id,
      );
    if (
      p.batch_id &&
      (batch?.status !== "checking" || batch.check?.recheck_requested)
    )
      return;
    const check = p.batch_id
      ? batch?.check
      : latestMergeCheck(state.events, p.card_id, p.completion_id);
    const wait = batch
      ? batchQueueWait(state.events, batch)
      : check?.queue_wait;
    if (
      check?.status !== "queued" ||
      check.completion_id !== p.completion_id ||
      check.attempt_id !== p.attempt_id ||
      wait?.reason === p.reason
    )
      return;
    d.emit(
      "merge_check_waiting",
      card.id,
      {
        completion_id: p.completion_id,
        ...(p.batch_id ? { batch_id: p.batch_id } : {}),
        attempt_id: p.attempt_id,
        reason: p.reason,
        ...(p.repository_retry_at
          ? { repository_retry_at: p.repository_retry_at }
          : {}),
        queued_at: wait?.queued_at ?? check.updated_at,
      },
      { type: "system", body: `合并检查排队：${p.reason}` },
    );
  });
}
