import type { Card, CardHold } from "../entities.js";
import { type CommandDraft, ensure, text } from "./core.js";

export type CardHoldInput = Pick<
  CardHold,
  "reason" | "resume_condition"
> | null;

export function applyCardHold(
  d: CommandDraft,
  card: Card,
  input: CardHoldInput,
) {
  d.pm();
  d.projectAccess();
  ensure(
    !["done", "cancelled"].includes(card.status),
    "illegal_transition",
    "已结束卡片不能设置或解除暂停",
  );
  if (input !== null) {
    ensure(
      typeof input === "object" &&
        Object.keys(input).every((k) =>
          ["reason", "resume_condition"].includes(k),
        ),
      "validation_failed",
      "暂停只接受原因和恢复条件",
    );
    text(input.reason, "暂停原因");
    text(input.resume_condition, "恢复条件");
  }
  if (
    (!input && !card.hold) ||
    (input &&
      card.hold?.reason === input.reason.trim() &&
      card.hold.resume_condition === input.resume_condition.trim())
  )
    return card;
  const { hold: previous, ...rest } = card;
  const hold: CardHold | undefined = input
    ? {
        reason: input.reason.trim(),
        resume_condition: input.resume_condition.trim(),
        set_by: d.author,
        set_at: d.now,
      }
    : undefined;
  const result: Card = { ...rest, ...(hold ? { hold } : {}) };
  const notice = hold
    ? `已暂停：${hold.reason}\n恢复条件：${hold.resume_condition}`
    : "已解除暂停，后续按当前依赖和原有门禁继续。";
  d.put("cards", result);
  d.emit(
    hold ? "card_hold_set" : "card_hold_released",
    card.id,
    {
      card_id: card.id,
      notice,
      previous_hold: previous ? { ...previous } : null,
      hold: hold ? { ...hold } : null,
    },
    {
      type: "status_change",
      body: notice,
    },
  );
  return result;
}
