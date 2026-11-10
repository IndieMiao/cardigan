import type { Actor, Card } from "../entities.js";
import type { CardId } from "../ids.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import { handoffDecision } from "./delegation.js";

/**
 * C-65 (§7.4): only the human marks or unmarks a card as sensitive, from the
 * Workbench card detail or the local CLI. A sensitive card's merge
 * confirmation always goes to the human: PM Ops cannot confirm it and the
 * auto-merge timeout does not apply. Marking a card whose confirmation PM Ops
 * still holds hands that confirmation to the human at once.
 */
export function setCardSensitive(
  state: CommandState,
  actor: Actor,
  p: { card_id: CardId; sensitive: boolean },
  ports: CommandPorts,
) {
  return command(state, actor, "set_card_sensitive", ports, (d) => {
    ensure(
      actor.kind === "human",
      "forbidden_tool",
      "只有人能设置或取消卡片的敏感标记",
    );
    ensure(
      typeof p.sensitive === "boolean",
      "validation_failed",
      "sensitive must be a boolean",
    );
    const card = d.card(p.card_id);
    if (Boolean(card.sensitive) === p.sensitive) return card;
    const { sensitive: _old, ...rest } = card;
    const next: Card = p.sensitive ? { ...rest, sensitive: true } : rest;
    d.put("cards", next);
    d.emit(
      "card_sensitivity_changed",
      card.id,
      { card_id: card.id, sensitive: p.sensitive },
      {
        type: "status_change",
        body: p.sensitive
          ? "人将卡片标为敏感：合并确认一律由人亲自处理，PM 不能代确认，也不适用超时自动合并。"
          : "人取消了卡片的敏感标记：之后的合并确认按项目设置处理。",
      },
    );
    if (p.sensitive)
      for (const q of d.list("decisions"))
        if (
          q.trigger === "merge_confirmation" &&
          q.card_id === card.id &&
          q.decider === "role:pm" &&
          ["open", "provisional"].includes(q.status)
        )
          handoffDecision(
            d,
            q,
            "卡片已被人标为敏感，此合并确认转交给你亲自处理。",
          );
    return next;
  });
}
