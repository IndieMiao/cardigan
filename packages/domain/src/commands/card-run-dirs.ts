import type { Card, CardRunDirKeep } from "../entities.js";
import { type CommandDraft, ensure, text } from "./core.js";

export type CardRunDirKeepInput = Pick<CardRunDirKeep, "reason"> | null;

/**
 * C-743: PM names a card whose released Assignments keep their run
 * directories (evidence for an investigation). Unlike a hold this also
 * applies to done and cancelled cards: that is where reclaim happens.
 */
export function applyKeepRunDirs(
  d: CommandDraft,
  card: Card,
  input: CardRunDirKeepInput,
) {
  d.pm();
  d.projectAccess();
  if (input !== null) {
    ensure(
      typeof input === "object" &&
        Object.keys(input).every((k) => k === "reason"),
      "validation_failed",
      "保留运行目录只接受原因",
    );
    text(input.reason, "保留原因");
  }
  if (
    (!input && !card.keep_run_dirs) ||
    (input && card.keep_run_dirs?.reason === input.reason.trim())
  )
    return card;
  const { keep_run_dirs: previous, ...rest } = card;
  const keep: CardRunDirKeep | undefined = input
    ? { reason: input.reason.trim(), set_by: d.author, set_at: d.now }
    : undefined;
  const result: Card = { ...rest, ...(keep ? { keep_run_dirs: keep } : {}) };
  d.put("cards", result);
  const notice = keep
    ? `已保留本卡已释放指派的运行目录，不自动回收：${keep.reason}`
    : "已取消保留运行目录，之后按回收策略处理";
  d.emit(
    keep ? "card_run_dirs_keep_set" : "card_run_dirs_keep_released",
    card.id,
    {
      card_id: card.id,
      notice,
      previous_keep_run_dirs: previous ? { ...previous } : null,
      keep_run_dirs: keep ? { ...keep } : null,
    },
    { type: "status_change", body: notice },
  );
  return result;
}
