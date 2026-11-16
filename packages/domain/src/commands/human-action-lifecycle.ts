import type { Actor, HumanAction } from "../entities.js";
import type { CardId, HumanActionId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  text,
  unwrap,
} from "./core.js";
import { queueResumedRun, resumeWork } from "./resumption.js";

function cancelActionDraft(
  d: CommandDraft,
  action: HumanAction,
  reason: string,
  source: "human" | "card_cancelled",
) {
  text(reason, "reason");
  const result: HumanAction = {
    ...action,
    status: unwrap(transition("human_action", action.status, "cancel")),
    cancellation: { reason: reason.trim(), by: d.author, at: d.now, source },
  };
  d.put("human_actions", result);
  const resumed = action.blocked_work_items.flatMap((id) => {
    const item = d.work(id);
    if (["done", "cancelled"].includes(d.card(item.card_id).status)) return [];
    const next = resumeWork(d, item);
    return next ? [next] : [];
  });
  const event = d.emit(
    "human_action_cancelled",
    action.card_id,
    {
      human_action_id: action.id,
      reason: reason.trim(),
      source,
      resume_work_items: resumed.map((w) => w.id),
    },
    {
      type: "human_action",
      human_action_id: action.id,
      body: `${action.id} ${source === "card_cancelled" ? "随卡取消" : "已关闭（不再需要）"}：${reason.trim()}。未记为完成。`,
    },
  );
  for (const item of resumed) queueResumedRun(d, item, event);
  return result;
}

/** Closing is a human decision, not a report that the work was performed. */
export function cancelHumanAction(
  state: CommandState,
  actor: Actor,
  p: { human_action_id: HumanActionId; reason: string },
  ports: CommandPorts,
) {
  return command(state, actor, "cancel_human_action", ports, (d) => {
    const action = d.get("human_actions", p.human_action_id);
    const card = action.card_id ? d.card(action.card_id) : undefined;
    return cancelActionDraft(
      d,
      action,
      p.reason,
      card?.status === "cancelled" ? "card_cancelled" : "human",
    );
  });
}

export function cancelCardHumanActions(d: CommandDraft, cardId: CardId) {
  for (const action of d.list("human_actions"))
    if (action.card_id === cardId && action.status === "open")
      cancelActionDraft(
        d,
        action,
        "卡片已取消，此待办不再需要",
        "card_cancelled",
      );
}

/** System-only, repeatable compensation for old cancelled cards. */
export function refreshCancelledHumanActions(
  state: CommandState,
  actor: Actor,
  ports: CommandPorts,
) {
  return command(
    state,
    actor,
    "refresh_cancelled_human_actions",
    ports,
    (d) => {
      for (const card of d.list("cards"))
        if (card.status === "cancelled") cancelCardHumanActions(d, card.id);
    },
  );
}
