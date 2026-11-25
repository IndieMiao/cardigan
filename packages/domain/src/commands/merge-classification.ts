import type {
  Card,
  MergeClassificationInput,
  PreMergeCheckedVersion,
} from "../entities.js";
import { fullEventHistory } from "../event-index.js";
import { type CommandDraft, type CommandState, ensure } from "./core.js";
import { currentPreMergeVersions } from "./pre-merge-checks.js";

export function sameMergeVersions(
  a: readonly PreMergeCheckedVersion[],
  b: readonly PreMergeCheckedVersion[],
) {
  return (
    a.length === b.length &&
    a.every(
      (v, i) =>
        v.work_item_id === b[i]?.work_item_id &&
        v.delivery_id === b[i]?.delivery_id &&
        v.subject === b[i]?.subject,
    )
  );
}
export function sameRiskTags(a: readonly string[], b: readonly string[]) {
  return (
    JSON.stringify([...new Set(a)].sort()) ===
    JSON.stringify([...new Set(b)].sort())
  );
}
export function mergeClassificationView(
  state: Pick<CommandState, "work_items" | "deliveries">,
  card: Card,
) {
  const record = card.merge_classification;
  if (!record) return undefined;
  return {
    ...record,
    stale:
      !sameMergeVersions(
        record.checked_versions,
        currentPreMergeVersions(card, state.work_items, state.deliveries),
      ) || !sameRiskTags(record.risk_tags, card.risk_tags ?? []),
  };
}

/** Reuse update_card: standing PMs and humans only, no new Agent tool. */
export function applyMergeClassification(
  d: CommandDraft,
  card: Card,
  input: MergeClassificationInput,
): Card {
  ensure(
    d.actor.kind === "human" ||
      (d.assignment?.scope === "standing" && d.assignment.role_id === "pm"),
    "forbidden_tool",
    "只有常驻 PM 或人可以记录合并前分类确认",
  );
  ensure(
    !["done", "cancelled"].includes(card.status),
    "illegal_transition",
    "Card is closed",
  );
  ensure(
    input !== null && typeof input === "object",
    "validation_failed",
    "分类确认须完整填写",
  );
  for (const key of [
    "risk_reviewed",
    "is_ui",
    "numeric_rules_approved",
    "not_external_release",
    "no_role_changes",
    "timeline_reviewed",
  ] as const)
    ensure(
      typeof input[key] === "boolean",
      "validation_failed",
      `${key} 须明确填写是或否`,
    );
  const versions = currentPreMergeVersions(
    card,
    d.list("work_items"),
    d.list("deliveries"),
  );
  const producers = d
    .list("work_items")
    .filter(
      (w) =>
        w.card_id === card.id &&
        w.kind === "produce" &&
        w.status !== "cancelled",
    );
  ensure(
    versions.length > 0 &&
      producers.length > 0 &&
      producers.every((w) => versions.some((v) => v.work_item_id === w.id)) &&
      Array.isArray(input.checked_versions) &&
      input.checked_versions.every((v) => v && typeof v === "object") &&
      sameMergeVersions(input.checked_versions, versions) &&
      versions.every(
        (v) => d.get("deliveries", v.delivery_id).subject.kind === "git_head",
      ),
    "validation_failed",
    "请读取每个产出项当前交付编号和 SHA 后重新分类确认",
  );
  ensure(
    Array.isArray(input.risk_tags) &&
      input.risk_tags.every((tag) =>
        ["security", "permission", "numeric_rule"].includes(tag),
      ) &&
      sameRiskTags(input.risk_tags, card.risk_tags ?? []),
    "validation_failed",
    "分类确认的风险标签须与卡片一致，请先补齐风险标签",
  );
  ensure(
    Array.isArray(input.numeric_decision_ids) &&
      input.numeric_decision_ids.every((id) =>
        d
          .list("decisions")
          .some(
            (q) =>
              q.id === id &&
              q.status === "resolved" &&
              q.resolution?.resolved_by === "human",
          ),
      ),
    "validation_failed",
    "数值拍板须引用人已亲自解决的拍板",
  );
  // The reader's sequence covers every event on the card, telemetry included.
  const events = fullEventHistory(d.state.events).filter(
    (e) => e.card_id === card.id,
  );
  const lastSeq = Math.max(0, ...events.map((e) => e.seq));
  ensure(
    Number.isSafeInteger(input.read_through_seq) &&
      input.read_through_seq >= 0 &&
      input.read_through_seq <= lastSeq &&
      !d.state.timeline.some(
        (e) =>
          e.card_id === card.id &&
          e.type === "comment" &&
          e.author !== "system" &&
          e.event_seq > input.read_through_seq,
      ),
    "validation_failed",
    "时间线有尚未覆盖的评论，请读完后重新分类确认",
  );
  // Copy only supported fields; caller cannot inject author, event order or timestamps.
  const confirmed: MergeClassificationInput = {
    checked_versions: versions.map((v) => ({ ...v })),
    read_through_seq: input.read_through_seq,
    risk_tags: [...new Set(input.risk_tags)].sort(),
    risk_reviewed: input.risk_reviewed,
    is_ui: input.is_ui,
    numeric_rules_approved: input.numeric_rules_approved,
    numeric_decision_ids: [...input.numeric_decision_ids],
    not_external_release: input.not_external_release,
    no_role_changes: input.no_role_changes,
    timeline_reviewed: input.timeline_reviewed,
  };
  const event = d.emit(
    "merge_classification_recorded",
    card.id,
    JSON.parse(JSON.stringify(confirmed)),
    {
      type: "status_change",
      body: `已记录合并前分类确认（${versions.map((v) => `${v.delivery_id}@${v.subject.slice(0, 12)}`).join("、")}）；仅供影子判定，不授权合并。`,
    },
  );
  const result: Card = {
    ...card,
    merge_classification: {
      ...confirmed,
      event_seq: event.seq,
      confirmed_by: d.author,
      confirmed_at: d.now,
    },
  };
  d.put("cards", result);
  return result;
}
