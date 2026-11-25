import { reviewPassed } from "../derived.js";
import type {
  Card,
  Delivery,
  HumanAction,
  PreMergeCheck,
  PreMergeCheckStatus,
  Review,
} from "../entities.js";
import { isOperatorAction } from "../human-action-executor.js";
import type { CardId, HumanActionId, ProjectId } from "../ids.js";
import { type CommandDraft, ensure, text } from "./core.js";
import { mergeBlockingHumanActions, syncScreenshotMerge } from "./merge.js";
import {
  currentPreMergeVersions,
  INDEPENDENT_REVIEW_CHECK_LABEL,
  reservedPreMergeCheckLabels as reservedLabels,
  samePreMergeCheckVersions as sameVersions,
} from "./pre-merge-check-view.js";
import {
  SCREENSHOT_CHECK_LABEL,
  screenshotCheckEnforced,
} from "./screenshot-check.js";

export {
  currentPreMergeVersions,
  type EffectivePreMergeCheck,
  effectivePreMergeChecks,
  INDEPENDENT_REVIEW_CHECK_LABEL,
  openPreMergeChecks,
} from "./pre-merge-check-view.js";

/** C-160: what a pre-merge check update carries through `update_card`. */
export interface PreMergeCheckInput {
  readonly label: string;
  readonly status: PreMergeCheckStatus;
  readonly note?: string;
}

export const PRE_MERGE_CHECK_STATUS_LABELS: Readonly<
  Record<PreMergeCheckStatus, string>
> = { pending: "待完成", passed: "已通过", failed: "有问题" };
/** Ordinary checks; the reserved independent review has its own slot. */
export const MAX_PRE_MERGE_CHECKS = 8;
const MAX_LABEL = 40;
const MAX_NOTE = 500;

/**
 * C-179: the persisted reminder written when a pre-merge check newly passes
 * while merge-blocking human actions are still open on the card.
 */
export const PRE_MERGE_CHECK_REMINDED = "pre_merge_check_reminded";
export interface PreMergeCheckReminder {
  readonly human_action_id: HumanActionId;
  readonly title: string;
  /** Who triages the action: PM Ops, or the human through Needs You. */
  readonly recipient: "pm_ops" | "needs_you";
  /** Workbench card route pointing at the action's timeline entry. */
  readonly link: string;
  readonly text: string;
}
export const humanActionLink = (
  project: ProjectId,
  card: CardId,
  id: HumanActionId,
) =>
  `#/p/${encodeURIComponent(project)}/cards/${encodeURIComponent(card)}?at=${encodeURIComponent(`human-action-${id}`)}`;
const humanActionTitle = (action: HumanAction): string => {
  const raw =
    action.handoff?.title ?? action.instructions.split(/\r?\n/u)[0] ?? "";
  const chars = [...raw.trim()];
  return chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : chars.join("");
};
/** Q-279 wording, decided by PM; the link follows on the same line. */
export const preMergeCheckReminderText = (
  label: string,
  id: HumanActionId,
  title: string,
) =>
  `合并前核对项「${label}」已通过，${id}「${title}」仍在挡合并，请确认是否可以完成`;

/**
 * C-160: add or update one pre-merge check on a card.
 *
 * Only standing PMs and the human may touch the list. PM Ops (and any other
 * non-Office PM) may only add a check or reset a `passed` one to `pending`; it
 * cannot withdraw a `failed` one; marking a check
 * `passed` or `failed` records a conclusion relayed from the human's review
 * channel, which is PM Office's job (§7.1), so it needs PM Office or the human.
 * The independent review label is reserved for submit_review projections;
 * direct updates may only reset it to pending. C-264 uses all effective checks
 * to gate ordinary human confirmation; PM delegation retains its own rules.
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
    label !== INDEPENDENT_REVIEW_CHECK_LABEL || input.status === "pending",
    "forbidden_tool",
    "独立复核的已通过或有问题结论只能由独立复核员提交审核生成",
  );
  // Q-336 (a): with the reviewer-browser switch on, the screenshot check is
  // reserved for the independent reviewer's projection, like 独立复核.
  ensure(
    label !== SCREENSHOT_CHECK_LABEL ||
      input.status === "pending" ||
      !screenshotCheckEnforced({
        project_id: d.state.project_id,
        project_preferences: d.list("project_preferences"),
      }),
    "forbidden_tool",
    "项目已开启截图核对计入代确认，截图核对的已通过或有问题结论只能由独立复核员提交审核生成",
  );
  ensure(
    input.status === "pending" || actor.kind === "human" || office,
    "forbidden_tool",
    "只有 PM Office 或人可以把合并前核对项标为已通过或有问题",
  );
  const previous = card.pre_merge_checks?.find((c) => c.label === label);
  // C-160#25: a "failed" conclusion records a problem the human was told
  // about; only PM Office or the human may withdraw it.
  ensure(
    previous?.status !== "failed" ||
      input.status === "failed" ||
      actor.kind === "human" ||
      office,
    "forbidden_tool",
    "只有 PM Office 或人可以撤销“有问题”的合并前核对项",
  );
  return writePreMergeCheck(d, card, {
    label,
    status: input.status,
    ...(note === undefined ? {} : { note }),
  });
}

/** Only submitReview calls this, after validating and recording the Review. */
export function projectIndependentReviewCheck(d: CommandDraft, review: Review) {
  ensure(
    d.tool === "submit_review" &&
      d.assignment?.role_id === "independent_reviewer",
    "forbidden_tool",
    "独立复核结论只能由独立复核员提交审核生成",
  );
  const item = d.ownWork(review.work_item_id);
  return writePreMergeCheck(d, d.card(item.card_id), {
    label: INDEPENDENT_REVIEW_CHECK_LABEL,
    status:
      reviewPassed(review) &&
      !review.issues.some(
        (i) =>
          i.must_fix && !(review.followup_card_id && i.impact === "ux_only"),
      )
        ? "passed"
        : "failed",
    note: review.test_review
      ? `增量复核（只改测试）；审核 ${review.id}`
      : `审核 ${review.id}`,
  });
}

/** Rebind an existing projection, preserving its actual reviewer and time. */
export function reuseIndependentReviewCheck(
  d: CommandDraft,
  review: Review,
  previous: Delivery,
  next: Delivery,
): void {
  if (d.work(review.work_item_id).role_id !== "independent_reviewer") return;
  const card = d.card(d.work(review.work_item_id).card_id);
  if (!card.pre_merge_checks) return;
  const checks = card.pre_merge_checks.map((c) => {
    if (
      !reservedLabels(screenshotCheckEnforced(d.state)).includes(c.label) ||
      c.status !== "passed" ||
      (c.label === SCREENSHOT_CHECK_LABEL &&
        c.note !== `审核 ${review.id}` &&
        c.reused_from !== review.id) ||
      !c.checked_versions?.some(
        (v) =>
          v.delivery_id === previous.id && v.subject === next.subject.value,
      )
    )
      return c;
    const ownsProjection =
      c.note === `审核 ${review.id}` ||
      c.note === `增量复核（只改测试）；审核 ${review.id}` ||
      c.reused_from === review.id;
    const versions = c.checked_versions.map((v) =>
      v.delivery_id === previous.id
        ? { ...v, delivery_id: next.id, reused_from: review.id }
        : v,
    );
    const sourceNote = ownsProjection
      ? `沿用自 ${review.id}（同一 SHA，原交付 ${review.delivery_id}）`
      : c.note?.split("；版本沿用：")[0];
    return {
      ...c,
      ...(ownsProjection ? { reused_from: review.id } : {}),
      note: `${sourceNote ?? ""}；版本沿用：${versions
        .filter((v) => v.reused_from)
        .map((v) => `${v.delivery_id} 沿用自 ${v.reused_from}`)
        .join("、")}`,
      checked_versions: versions,
    };
  });
  d.put("cards", { ...card, pre_merge_checks: checks });
}

/**
 * Q-336 (a): the screenshot conclusion of the same Review. Projected only
 * while the reviewer-browser switch is on; otherwise it stays on the Review
 * and the check keeps its C-86 owners (PM Office or the human).
 */
export function projectScreenshotCheck(d: CommandDraft, review: Review) {
  ensure(
    d.tool === "submit_review" &&
      d.assignment?.role_id === "independent_reviewer",
    "forbidden_tool",
    "截图核对结论只能由独立复核员提交审核生成",
  );
  if (
    review.screenshot_check === undefined ||
    !screenshotCheckEnforced({
      project_id: d.state.project_id,
      project_preferences: d.list("project_preferences"),
    })
  )
    return;
  const item = d.ownWork(review.work_item_id);
  writePreMergeCheck(d, d.card(item.card_id), {
    label: SCREENSHOT_CHECK_LABEL,
    status: review.screenshot_check,
    note: `审核 ${review.id}`,
  });
}

/** Withdrawal invalidates only the projections written by this review owner. */
export function withdrawIndependentReviewCheck(
  d: CommandDraft,
  review: Review,
) {
  ensure(
    d.tool === "withdraw_review" &&
      d.assignment?.role_id === "independent_reviewer",
    "forbidden_tool",
    "独立复核结论只能随独立复核员本人撤回审核失效",
  );
  const item = d.ownWork(review.work_item_id);
  for (const label of [
    INDEPENDENT_REVIEW_CHECK_LABEL,
    SCREENSHOT_CHECK_LABEL,
  ]) {
    const card = d.card(item.card_id);
    const check = card.pre_merge_checks?.find((c) => c.label === label);
    // Another reviewer may have since replaced the single fixed projection;
    // a manual pending reset likewise must retain its author and explanation.
    // The screenshot projection is withdrawn only if this review wrote it.
    if (
      !check ||
      (check.updated_by !== d.author &&
        !check.checked_versions?.some((v) => v.reused_from === review.id)) ||
      check.status === "pending" ||
      (label === SCREENSHOT_CHECK_LABEL &&
        check.note !== `审核 ${review.id}` &&
        check.reused_from !== review.id)
    )
      continue;
    writePreMergeCheck(d, card, {
      label,
      status: "pending",
      note: `审核 ${review.id} 已撤回`,
    });
  }
}

/** Shared persistence keeps the Review projection and its audit in one draft. */
function writePreMergeCheck(
  d: CommandDraft,
  card: Card,
  input: PreMergeCheckInput,
): Card {
  const { label, note } = input;
  const enforced = screenshotCheckEnforced({
    project_id: d.state.project_id,
    project_preferences: d.list("project_preferences"),
  });
  const reserved = reservedLabels(enforced);
  ensure(
    card.status !== "done" && card.status !== "cancelled",
    "illegal_transition",
    "Card is closed",
  );
  const checks = card.pre_merge_checks ?? [];
  const previous = checks.find((c) => c.label === label);
  ensure(
    previous !== undefined ||
      reserved.includes(label) ||
      checks.filter((c) => !reserved.includes(c.label)).length <
        MAX_PRE_MERGE_CHECKS,
    "validation_failed",
    `一张卡最多 ${MAX_PRE_MERGE_CHECKS} 个普通合并前核对项，${reserved.join("、")}另计`,
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
      sameVersions(previous.checked_versions, versions, label, enforced))
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
  // C-179: a new pass (not a note-only edit on the same version) reminds the
  // triage owner of every open merge-blocking human action. Only a reminder:
  // the action stays open and keeps holding the merge.
  if (
    input.status === "passed" &&
    !(
      previous?.status === "passed" &&
      versions !== undefined &&
      sameVersions(previous.checked_versions, versions, label, enforced)
    )
  )
    remindMergeBlockingActions(d, card.id, label);
  if (label === SCREENSHOT_CHECK_LABEL) syncScreenshotMerge(d, result);
  return result;
}
function remindMergeBlockingActions(
  d: CommandDraft,
  card: CardId,
  label: string,
) {
  const actions = mergeBlockingHumanActions(
    {
      human_actions: d.list("human_actions"),
      work_items: d.list("work_items"),
    },
    card,
    // C-742: 张良's actions never remind the owner.
  ).filter((action) => !isOperatorAction(action));
  if (actions.length === 0) return;
  const reminders: PreMergeCheckReminder[] = actions.map((action) => {
    const title = humanActionTitle(action);
    return {
      human_action_id: action.id,
      title,
      recipient: action.triage === "pm_ops" ? "pm_ops" : "needs_you",
      link: humanActionLink(d.state.project_id, card, action.id),
      text: preMergeCheckReminderText(label, action.id, title),
    };
  });
  d.emit(
    PRE_MERGE_CHECK_REMINDED,
    card,
    {
      card_id: card,
      label,
      reminders: reminders.map((r) => ({ ...r })),
    },
    {
      type: "system",
      author: "system",
      body: reminders.map((r) => `${r.text}：${r.link}`).join("\n"),
      refs: reminders.map((r) => ({
        kind: "human_action" as const,
        id: r.human_action_id,
      })),
    },
  );
}
/** C-179: the newest reminder naming this open action, for Needs You. */
export function latestPreMergeCheckReminder(
  events: readonly {
    type: string;
    card_id?: string;
    payload: unknown;
    created_at: string;
  }[],
  action: Pick<HumanAction, "id" | "card_id" | "status">,
):
  | (PreMergeCheckReminder & { readonly label: string; readonly at: string })
  | undefined {
  if (action.status !== "open" || !action.card_id) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type !== PRE_MERGE_CHECK_REMINDED || e.card_id !== action.card_id)
      continue;
    const payload = e.payload as {
      label?: unknown;
      reminders?: readonly PreMergeCheckReminder[];
    } | null;
    const hit = Array.isArray(payload?.reminders)
      ? payload.reminders.find((r) => r?.human_action_id === action.id)
      : undefined;
    if (hit && typeof payload?.label === "string")
      return { ...hit, label: payload.label, at: e.created_at };
  }
  return undefined;
}
