import type { Actor, MergeCheckView } from "../entities.js";
import type { CardId } from "../ids.js";
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
  },
  ports: CommandPorts,
) {
  return command(state, actor, "record_merge_check_wait", ports, (d) => {
    d.projectAccess();
    text(p.reason, "reason");
    const context = attempt(() => mergeContext(state, p.card_id));
    if (!context.ok || context.value.target.id !== p.completion_id) return;
    const card = context.value.card;
    const check = latestMergeCheck(state.events, p.card_id, p.completion_id);
    if (
      check?.status !== "queued" ||
      check.attempt_id !== p.attempt_id ||
      check.queue_wait?.reason === p.reason
    )
      return;
    d.emit(
      "merge_check_waiting",
      card.id,
      {
        completion_id: p.completion_id,
        attempt_id: p.attempt_id,
        reason: p.reason,
        queued_at: check.queue_wait?.queued_at ?? check.updated_at,
      },
      { type: "system", body: `合并检查排队：${p.reason}` },
    );
  });
}
