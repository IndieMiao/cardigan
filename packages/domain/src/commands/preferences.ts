import type { Actor } from "../entities.js";
import {
  contextUsageThresholds,
  type DecisionCategory,
  decisionCategories,
  decisionDelegation,
  highRiskCategories,
  independentReviewMaxRounds,
  isBoardLane,
  mergeConfirmSnoozeDefaultMinutes,
  mergeConfirmSnoozeMaxMinutes,
  mergeConfirmStallAfterMinutes,
  pmMergeConfirmation,
  REVIEW_MAX_ROUNDS_CEILING,
  reviewerBrowserEnabled,
  reviewMaxRounds,
  type SystemReminderPolicy,
  validAutoMergeMinutes,
  validContextPercentage,
  validMergeConfirmSnoozeMaxMinutes,
  validMergeConfirmStallMinutes,
  validReviewMaxRounds,
  validSystemReminderPolicy,
} from "../preferences.js";
import { states } from "../states.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import { handoffUnauthorizedDecisions } from "./delegation.js";
import { syncScreenshotMerge } from "./merge.js";

export function projectPreferences(state: CommandState) {
  return (
    state.project_preferences?.find((p) => p.id === state.project_id) ?? {
      id: state.project_id,
      auto_merge_after_minutes: null,
    }
  );
}

export function setProjectPreferences(
  state: CommandState,
  actor: Actor,
  input: {
    system_auto_assign_verifiers?: boolean;
    system_reminders?: boolean;
    system_reminder_policy?: SystemReminderPolicy | null;
    auto_merge_after_minutes?: number | null;
    context_handoff_remaining_pct?: number;
    context_restart_remaining_pct?: number;
    merge_confirm_stall_after_minutes?: number;
    merge_confirm_snooze_default_minutes?: number;
    merge_confirm_snooze_max_minutes?: number;
    decision_delegation?: Partial<Record<DecisionCategory, boolean>>;
    pm_merge_confirmation?: boolean;
    /** P2a-14 ⑧ gray switch; see `ProjectPreferences.enable_reviewer_browser`. */
    enable_reviewer_browser?: boolean;
    /** A patch: only the listed lanes change; null forgets the human setting. */
    board_collapsed_lanes?: Readonly<Record<string, boolean | null>>;
    /** C-253: only affects verifiers created afterwards. */
    review_max_rounds?: number;
    independent_review_max_rounds?: number;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "set_project_preferences", ports, (d) => {
    ensure(
      actor.kind === "human",
      "unauthorized",
      "Only the human can change project preferences",
    );
    ensure(
      input.auto_merge_after_minutes === undefined ||
        validAutoMergeMinutes(input.auto_merge_after_minutes),
      "validation_failed",
      "自动合并等待时间须为 1 到 1440 的整数分钟，或 null（关闭）",
    );
    ensure(
      input.merge_confirm_stall_after_minutes === undefined ||
        validMergeConfirmStallMinutes(input.merge_confirm_stall_after_minutes),
      "validation_failed",
      "合并确认停留告警时间须为 1 到 1440 的整数分钟",
    );
    ensure(
      input.merge_confirm_snooze_default_minutes === undefined ||
        validMergeConfirmStallMinutes(
          input.merge_confirm_snooze_default_minutes,
        ),
      "validation_failed",
      "合并确认默认暂缓时长须为 1 到 1440 的整数分钟",
    );
    ensure(
      input.merge_confirm_snooze_max_minutes === undefined ||
        validMergeConfirmSnoozeMaxMinutes(
          input.merge_confirm_snooze_max_minutes,
        ),
      "validation_failed",
      "合并确认最长暂缓时长须为 60 到 10080 的整数分钟",
    );
    ensure(
      (input.review_max_rounds === undefined ||
        validReviewMaxRounds(input.review_max_rounds)) &&
        (input.independent_review_max_rounds === undefined ||
          validReviewMaxRounds(input.independent_review_max_rounds)),
      "validation_failed",
      `审核轮数上限须为 1 到 ${REVIEW_MAX_ROUNDS_CEILING} 的整数`,
    );
    ensure(
      (input.context_handoff_remaining_pct === undefined ||
        validContextPercentage(input.context_handoff_remaining_pct)) &&
        (input.context_restart_remaining_pct === undefined ||
          validContextPercentage(input.context_restart_remaining_pct)),
      "validation_failed",
      "上下文剩余比例须为大于 0 且小于 100 的有限数值",
    );
    for (const key of [
      "system_auto_assign_verifiers",
      "system_reminders",
    ] as const)
      ensure(
        input[key] === undefined || typeof input[key] === "boolean",
        "validation_failed",
        `${key} must be a boolean`,
      );
    ensure(
      input.system_reminder_policy === undefined ||
        validSystemReminderPolicy(input.system_reminder_policy),
      "validation_failed",
      "催办配置须完整填写：分钟数和次数须为允许范围内的正整数，重复提醒须填写间隔；不重复时，间隔须为空",
    );
    const old = projectPreferences(state);
    const contextNext = contextUsageThresholds({
      ...old,
      ...(input.context_handoff_remaining_pct !== undefined
        ? { context_handoff_remaining_pct: input.context_handoff_remaining_pct }
        : {}),
      ...(input.context_restart_remaining_pct !== undefined
        ? { context_restart_remaining_pct: input.context_restart_remaining_pct }
        : {}),
    });
    ensure(
      validContextPercentage(contextNext.handoff) &&
        validContextPercentage(contextNext.restart) &&
        contextNext.restart < contextNext.handoff,
      "validation_failed",
      "上下文剩余比例须大于 0 且小于 100，换会话比例必须小于交接提醒比例",
    );
    ensure(
      input.system_auto_assign_verifiers !== undefined ||
        input.system_reminders !== undefined ||
        input.system_reminder_policy !== undefined ||
        input.context_handoff_remaining_pct !== undefined ||
        input.context_restart_remaining_pct !== undefined ||
        input.auto_merge_after_minutes !== undefined ||
        input.merge_confirm_stall_after_minutes !== undefined ||
        input.merge_confirm_snooze_default_minutes !== undefined ||
        input.merge_confirm_snooze_max_minutes !== undefined ||
        input.decision_delegation !== undefined ||
        input.pm_merge_confirmation !== undefined ||
        input.enable_reviewer_browser !== undefined ||
        input.board_collapsed_lanes !== undefined ||
        input.review_max_rounds !== undefined ||
        input.independent_review_max_rounds !== undefined,
      "validation_failed",
      "No preference supplied",
    );
    ensure(
      input.pm_merge_confirmation === undefined ||
        typeof input.pm_merge_confirmation === "boolean",
      "validation_failed",
      "pm_merge_confirmation must be a boolean",
    );
    ensure(
      input.enable_reviewer_browser === undefined ||
        typeof input.enable_reviewer_browser === "boolean",
      "validation_failed",
      "enable_reviewer_browser must be a boolean",
    );
    const delegation = { ...decisionDelegation(old) };
    for (const [category, enabled] of Object.entries(
      input.decision_delegation ?? {},
    )) {
      ensure(
        decisionCategories.includes(category as DecisionCategory) &&
          typeof enabled === "boolean",
        "validation_failed",
        "Unknown decision category or authorization",
      );
      ensure(
        !highRiskCategories.includes(category as DecisionCategory),
        "unauthorized",
        "高风险类别固定由人确认（Workbench 或本机 CLI）",
      );
      delegation[category as DecisionCategory] = enabled;
    }
    const lanes: Partial<Record<string, boolean>> = {
      ...old.board_collapsed_lanes,
    };
    for (const [lane, collapsed] of Object.entries(
      input.board_collapsed_lanes ?? {},
    )) {
      ensure(
        isBoardLane(lane) &&
          (collapsed === null || typeof collapsed === "boolean"),
        "validation_failed",
        "Unknown board lane or collapse setting",
      );
      if (collapsed === null) delete lanes[lane];
      else lanes[lane] = collapsed;
    }
    const next = {
      ...old,
      ...(input.system_auto_assign_verifiers !== undefined
        ? { system_auto_assign_verifiers: input.system_auto_assign_verifiers }
        : {}),
      ...(input.system_reminders !== undefined
        ? { system_reminders: input.system_reminders }
        : {}),
      ...(input.system_reminder_policy !== undefined
        ? { system_reminder_policy: input.system_reminder_policy }
        : {}),
      ...(input.context_handoff_remaining_pct !== undefined
        ? { context_handoff_remaining_pct: input.context_handoff_remaining_pct }
        : {}),
      ...(input.context_restart_remaining_pct !== undefined
        ? { context_restart_remaining_pct: input.context_restart_remaining_pct }
        : {}),
      auto_merge_after_minutes:
        input.auto_merge_after_minutes === undefined
          ? old.auto_merge_after_minutes
          : input.auto_merge_after_minutes,
      ...(input.merge_confirm_stall_after_minutes !== undefined
        ? {
            merge_confirm_stall_after_minutes:
              input.merge_confirm_stall_after_minutes,
          }
        : {}),
      ...(input.merge_confirm_snooze_default_minutes !== undefined
        ? {
            merge_confirm_snooze_default_minutes:
              input.merge_confirm_snooze_default_minutes,
          }
        : {}),
      ...(input.decision_delegation ? { decision_delegation: delegation } : {}),
      ...(input.merge_confirm_snooze_max_minutes !== undefined
        ? {
            merge_confirm_snooze_max_minutes:
              input.merge_confirm_snooze_max_minutes,
          }
        : {}),
      ...(input.pm_merge_confirmation !== undefined
        ? { pm_merge_confirmation: input.pm_merge_confirmation }
        : {}),
      ...(input.enable_reviewer_browser !== undefined
        ? { enable_reviewer_browser: input.enable_reviewer_browser }
        : {}),
      ...(input.board_collapsed_lanes ? { board_collapsed_lanes: lanes } : {}),
      ...(input.review_max_rounds !== undefined
        ? { review_max_rounds: input.review_max_rounds }
        : {}),
      ...(input.independent_review_max_rounds !== undefined
        ? {
            independent_review_max_rounds: input.independent_review_max_rounds,
          }
        : {}),
    };
    const systemKeys = [
      "system_auto_assign_verifiers",
      "system_reminders",
      "system_reminder_policy",
    ] as const;
    const encodeSystemPreference = (value: unknown) =>
      JSON.stringify(
        value,
        value && typeof value === "object"
          ? Object.keys(value).sort()
          : undefined,
      );
    const systemChanged = systemKeys.filter(
      (key) =>
        encodeSystemPreference(
          old[key] ?? (key === "system_reminder_policy" ? null : false),
        ) !==
        encodeSystemPreference(
          next[key] ?? (key === "system_reminder_policy" ? null : false),
        ),
    );
    const contextOld = contextUsageThresholds(old);
    const contextChanged =
      contextOld.handoff !== contextNext.handoff ||
      contextOld.restart !== contextNext.restart;
    const mergeChanged =
      old.auto_merge_after_minutes !== next.auto_merge_after_minutes;
    const stallChanged =
      mergeConfirmStallAfterMinutes(old) !==
      mergeConfirmStallAfterMinutes(next);
    const snoozeChanged =
      mergeConfirmSnoozeDefaultMinutes(old) !==
      mergeConfirmSnoozeDefaultMinutes(next);
    const delegationChanged = decisionCategories.some(
      (c) => decisionDelegation(old)[c] !== delegation[c],
    );
    const snoozeMaxChanged =
      mergeConfirmSnoozeMaxMinutes(old) !== mergeConfirmSnoozeMaxMinutes(next);
    const pmMergeChanged =
      pmMergeConfirmation(old) !== pmMergeConfirmation(next);
    const reviewerBrowserChanged =
      reviewerBrowserEnabled(old) !== reviewerBrowserEnabled(next);
    const reviewRoundsChanged = (
      [
        ["review_max_rounds", reviewMaxRounds],
        ["independent_review_max_rounds", independentReviewMaxRounds],
      ] as const
    ).filter(([, read]) => read(old) !== read(next));
    const oldLanes: Partial<Record<string, boolean>> =
      old.board_collapsed_lanes ?? {};
    const lanesChanged =
      input.board_collapsed_lanes !== undefined &&
      states.card.some((lane) => oldLanes[lane] !== lanes[lane]);
    if (
      !systemChanged.length &&
      !contextChanged &&
      !mergeChanged &&
      !stallChanged &&
      !snoozeChanged &&
      !snoozeMaxChanged &&
      !delegationChanged &&
      !pmMergeChanged &&
      !reviewerBrowserChanged &&
      !lanesChanged &&
      !reviewRoundsChanged.length
    )
      return old;
    // Lane folding is a view setting: it is stored for every device but emits
    // no audit event, so toggling a lane never feeds the activity stream.
    d.put("project_preferences", next);
    for (const preference of systemChanged)
      d.emit("project_preferences_updated", undefined, {
        preference,
        old_value:
          old[preference] === undefined
            ? null
            : JSON.parse(JSON.stringify(old[preference])),
        new_value: JSON.parse(JSON.stringify(next[preference])),
      });
    for (const [key, preference] of [
      ["handoff", "context_handoff_remaining_pct"],
      ["restart", "context_restart_remaining_pct"],
    ] as const) {
      if (contextOld[key] !== contextNext[key])
        d.emit("project_preferences_updated", undefined, {
          old_value: contextOld[key],
          new_value: contextNext[key],
          preference,
        });
    }
    if (mergeChanged)
      d.emit("project_preferences_updated", undefined, {
        old_value: old.auto_merge_after_minutes,
        new_value: next.auto_merge_after_minutes,
        preference: "auto_merge_after_minutes",
      });
    if (stallChanged)
      d.emit("project_preferences_updated", undefined, {
        old_value: mergeConfirmStallAfterMinutes(old),
        new_value: mergeConfirmStallAfterMinutes(next),
        preference: "merge_confirm_stall_after_minutes",
      });
    if (snoozeChanged)
      d.emit("project_preferences_updated", undefined, {
        old_value: mergeConfirmSnoozeDefaultMinutes(old),
        new_value: mergeConfirmSnoozeDefaultMinutes(next),
        preference: "merge_confirm_snooze_default_minutes",
      });
    if (snoozeMaxChanged)
      d.emit("project_preferences_updated", undefined, {
        old_value: mergeConfirmSnoozeMaxMinutes(old),
        new_value: mergeConfirmSnoozeMaxMinutes(next),
        preference: "merge_confirm_snooze_max_minutes",
      });
    for (const [preference, read] of reviewRoundsChanged)
      d.emit("project_preferences_updated", undefined, {
        old_value: read(old),
        new_value: read(next),
        preference,
      });
    if (delegationChanged) {
      d.emit("project_preferences_updated", undefined, {
        old_value: decisionDelegation(old),
        new_value: delegation,
        preference: "decision_delegation",
      });
      handoffUnauthorizedDecisions(d, "项目授权已关闭，此拍板转交给你。");
    }
    if (pmMergeChanged) {
      d.emit("project_preferences_updated", undefined, {
        old_value: pmMergeConfirmation(old),
        new_value: pmMergeConfirmation(next),
        preference: "pm_merge_confirmation",
      });
      // Turning it off returns open PM merge confirmations to the human.
      handoffUnauthorizedDecisions(
        d,
        "合并由 PM 代确认已关闭，此合并确认转交给你。",
      );
    }
    if (reviewerBrowserChanged) {
      d.emit("project_preferences_updated", undefined, {
        old_value: reviewerBrowserEnabled(old),
        new_value: reviewerBrowserEnabled(next),
        preference: "enable_reviewer_browser",
      });
      // Turning it on voids unpublished delegated merges of UI cards whose
      // screenshot check was not projected by an independent reviewer.
      for (const card of d.list("cards")) syncScreenshotMerge(d, card);
    }
    return next;
  });
}
