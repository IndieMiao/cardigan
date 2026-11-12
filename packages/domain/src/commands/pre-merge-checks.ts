import type {
  Card,
  Delivery,
  PreMergeCheck,
  PreMergeCheckedVersion,
  PreMergeCheckStatus,
  WorkItem,
} from "../entities.js";
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

const numericId = (id: string): number => Number(/(\d+)$/u.exec(id)?.[1] ?? 0);

/**
 * The version a pre-merge conclusion applies to: each producing work item's
 * newest non-superseded delivery (the same candidates the merge will take).
 */
export function currentPreMergeVersions(
  card: Pick<Card, "id">,
  workItems: readonly WorkItem[],
  deliveries: readonly Delivery[],
): readonly PreMergeCheckedVersion[] {
  return workItems
    .filter((w) => w.card_id === card.id && w.kind === "produce")
    .sort((a, b) => numericId(a.id) - numericId(b.id))
    .flatMap((w) => {
      const latest = deliveries
        .filter(
          (d) =>
            d.work_item_id === w.id &&
            d.kind !== "card_completion" &&
            d.status !== "superseded",
        )
        .sort((a, b) => numericId(b.id) - numericId(a.id))[0];
      return latest
        ? [
            {
              work_item_id: w.id,
              delivery_id: latest.id,
              subject: latest.subject.value,
            },
          ]
        : [];
    });
}
const sameVersions = (
  a: readonly PreMergeCheckedVersion[] | undefined,
  b: readonly PreMergeCheckedVersion[],
) =>
  a !== undefined &&
  a.length === b.length &&
  a.every(
    (v, i) =>
      v.work_item_id === b[i]?.work_item_id && v.subject === b[i]?.subject,
  );

export interface EffectivePreMergeCheck extends PreMergeCheck {
  /** A passed/failed conclusion reached on an older version; reads as pending. */
  readonly stale: boolean;
}
/**
 * C-160: a passed/failed conclusion only holds for the version it was reached
 * on. After rework the check reads as pending again until PM Office records a
 * conclusion for the new version.
 */
export function effectivePreMergeChecks(
  card: Pick<Card, "id" | "pre_merge_checks">,
  workItems: readonly WorkItem[],
  deliveries: readonly Delivery[],
): readonly EffectivePreMergeCheck[] {
  const current = currentPreMergeVersions(card, workItems, deliveries);
  return (card.pre_merge_checks ?? []).map((c) =>
    c.status !== "pending" && !sameVersions(c.checked_versions, current)
      ? { ...c, status: "pending", stale: true }
      : { ...c, stale: false },
  );
}
/** The checks still standing between the human and a clean merge. */
export function openPreMergeChecks(
  card: Pick<Card, "id" | "pre_merge_checks">,
  workItems: readonly WorkItem[],
  deliveries: readonly Delivery[],
): readonly EffectivePreMergeCheck[] {
  return effectivePreMergeChecks(card, workItems, deliveries).filter(
    (c) => c.status !== "passed",
  );
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
  const versions =
    input.status === "pending"
      ? undefined
      : currentPreMergeVersions(
          card,
          d.list("work_items"),
          d.list("deliveries"),
        );
  ensure(
    versions === undefined || versions.length > 0,
    "illegal_transition",
    "还没有可核对的交付版本，不能标为已通过或有问题",
  );
  if (
    previous?.status === input.status &&
    previous.note === note &&
    (versions === undefined ||
      sameVersions(previous.checked_versions, versions))
  )
    return card;
  const next: PreMergeCheck = {
    label,
    status: input.status,
    ...(note === undefined ? {} : { note }),
    ...(versions === undefined ? {} : { checked_versions: versions }),
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
      ...(versions === undefined
        ? {}
        : {
            checked_versions: versions.map((v) => ({
              work_item_id: v.work_item_id,
              delivery_id: v.delivery_id,
              subject: v.subject,
            })),
          }),
    },
    {
      type: "status_change",
      body: `合并前核对「${label}」：${change}${
        versions === undefined
          ? ""
          : `（核对版本 ${versions
              .map((v) => `${v.delivery_id}@${v.subject.slice(0, 12)}`)
              .join("、")}）`
      }${note ? `。备注：${note}` : ""}`,
    },
  );
  return result;
}
