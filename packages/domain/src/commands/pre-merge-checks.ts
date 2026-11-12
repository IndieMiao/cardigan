import type { Card, PreMergeCheck, PreMergeCheckStatus } from "../entities.js";
import { type CommandDraft, ensure, text } from "./core.js";

/** C-160: what a pre-merge check update carries through `update_card`. */
export interface PreMergeCheckInput {
  readonly label: string;
  readonly status: PreMergeCheckStatus;
  readonly note?: string;
}

export const PRE_MERGE_CHECK_STATUS_LABELS: Readonly<
  Record<PreMergeCheckStatus, string>
> = { pending: "待完成", passed: "已通过", failed: "有问题" };
export const MAX_PRE_MERGE_CHECKS = 8;
const MAX_LABEL = 40;
const MAX_NOTE = 500;

/** The checks still standing between the human and a clean merge. */
export function openPreMergeChecks(
  card: Pick<Card, "pre_merge_checks">,
): readonly PreMergeCheck[] {
  return (card.pre_merge_checks ?? []).filter((c) => c.status !== "passed");
}

/**
 * C-160: add or update one pre-merge check on a card.
 *
 * Only standing PMs and the human may touch the list. PM Ops (and any other
 * non-Office PM) may only add or reset a check to `pending`; marking a check
 * `passed` or `failed` records a conclusion relayed from the human's review
 * channel, which is PM Office's job (§7.1), so it needs PM Office or the human.
 * The checks are advisory: they never change who may confirm the merge or the
 * auto-merge timeout.
 */
export function applyPreMergeCheck(
  d: CommandDraft,
  card: Card,
  input: PreMergeCheckInput,
): Card {
  const actor = d.actor;
  const standing =
    actor.kind === "assignment" &&
    actor.role_id === "pm" &&
    d.assignment?.scope === "standing";
  const office = standing && d.assignment?.standing_mode === "office";
  ensure(
    actor.kind === "human" || standing,
    "forbidden_tool",
    "只有 PM Office、PM Ops 或人可以设置合并前核对项",
  );
  ensure(
    input !== null && typeof input === "object",
    "validation_failed",
    "pre_merge_check is required",
  );
  text(input.label, "pre_merge_check.label");
  const label = input.label.trim();
  ensure(
    label.length <= MAX_LABEL && !/[\r\n]/u.test(label),
    "validation_failed",
    `核对项名称须为一行，不超过 ${MAX_LABEL} 字`,
  );
  ensure(
    ["pending", "passed", "failed"].includes(input.status),
    "validation_failed",
    "pre_merge_check.status must be pending, passed or failed",
  );
  ensure(
    input.note === undefined ||
      (typeof input.note === "string" && input.note.length <= MAX_NOTE),
    "validation_failed",
    `核对项备注不超过 ${MAX_NOTE} 字`,
  );
  const note = input.note?.trim() || undefined;
  ensure(
    input.status === "pending" || actor.kind === "human" || office,
    "forbidden_tool",
    "只有 PM Office 或人可以把合并前核对项标为已通过或有问题",
  );
  ensure(
    card.status !== "done" && card.status !== "cancelled",
    "illegal_transition",
    "Card is closed",
  );
  const checks = card.pre_merge_checks ?? [];
  const previous = checks.find((c) => c.label === label);
  ensure(
    previous !== undefined || checks.length < MAX_PRE_MERGE_CHECKS,
    "validation_failed",
    `一张卡最多 ${MAX_PRE_MERGE_CHECKS} 个合并前核对项`,
  );
  if (previous?.status === input.status && previous.note === note) return card;
  const next: PreMergeCheck = {
    label,
    status: input.status,
    ...(note === undefined ? {} : { note }),
    updated_by: d.author,
    updated_at: d.now,
  };
  const result: Card = {
    ...card,
    pre_merge_checks: previous
      ? checks.map((c) => (c === previous ? next : c))
      : [...checks, next],
  };
  d.put("cards", result);
  const status = PRE_MERGE_CHECK_STATUS_LABELS[input.status];
  const change = previous
    ? `${PRE_MERGE_CHECK_STATUS_LABELS[previous.status]} → ${status}`
    : `新增，${status}`;
  d.emit(
    "pre_merge_check_updated",
    card.id,
    {
      card_id: card.id,
      label,
      status: input.status,
      previous_status: previous?.status ?? null,
      ...(note === undefined ? {} : { note }),
    },
    {
      type: "status_change",
      body: `合并前核对「${label}」：${change}${note ? `。备注：${note}` : ""}`,
    },
  );
  return result;
}
