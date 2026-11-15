import type { Actor } from "../entities.js";
import {
  contextUsageThresholds,
  type DecisionCategory,
  decisionCategories,
  decisionDelegation,
  highRiskCategories,
  INDEPENDENT_REVIEW_DELEGATION_MAX,
  independentReviewMaxRounds,
  isBoardLane,
  type MergeShadowPolicy,
  mergeConfirmSnoozeDefaultMinutes,
  mergeConfirmSnoozeMaxMinutes,
  mergeConfirmStallAfterMinutes,
  pmConfirmHumanDecidedMerges,
  pmConfirmRoleRuleImplementations,
  pmMergeConfirmation,
  REVIEW_MAX_ROUNDS_CEILING,
  reviewerBrowserEnabled,
  reviewMaxRounds,
  type SystemReminderPolicy,
  tickProfileOn,
  validAutoMergeMinutes,
  validContextPercentage,
  validIndependentReviewDelegationMax,
  validMergeConfirmSnoozeMaxMinutes,
  validMergeConfirmStallMinutes,
  validMergeShadowPolicy,
  validReviewMaxRounds,
  validSystemReminderPolicy,
} from "../preferences.js";
import { states } from "../states.js";
import {
  validRoleRulePaths,
  validSystemReviewLimitMax,
} from "../system-review-limit.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import { handoffUnauthorizedDecisions } from "./delegation.js";
import { releaseCodeReviewPrecheckWaits } from "./delivery-precheck.js";
import {
  syncHumanDecidedMerges,
  syncRoleRuleMerge,
  syncScreenshotMerge,
} from "./merge.js";

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
    code_review_waits_for_precheck?: boolean;
    system_review_limit_raise?: boolean;
    system_review_limit_max_raises?: number | null;
    role_rule_paths?: readonly string[] | null;
    system_merge_shadow?: boolean;
    system_merge_shadow_policy?: MergeShadowPolicy | null;
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
    pm_confirm_role_rule_implementations?: boolean;
    pm_confirm_human_decided_merges?: boolean;
    /** P2a-14 ⑧ gray switch; see `ProjectPreferences.enable_reviewer_browser`. */
    enable_reviewer_browser?: boolean;
    /** A patch: only the listed lanes change; null forgets the human setting. */
    board_collapsed_lanes?: Readonly<Record<string, boolean | null>>;
    /** C-253: only affects verifiers created afterwards. */
    review_max_rounds?: number;
    independent_review_max_rounds?: number;
    independent_review_limit_delegation?: boolean;
    independent_review_limit_delegation_max?: number | null;
    /** C-265: host loop timing switch; see `ProjectPreferences.tick_profile`. */
    tick_profile?: boolean;
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
      "code_review_waits_for_precheck",
      "system_review_limit_raise",
      "system_merge_shadow",
      "pm_confirm_human_decided_merges",
      "system_auto_assign_verifiers",
      "system_reminders",
      "independent_review_limit_delegation",
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
    ensure(
      input.system_review_limit_max_raises === undefined ||
        validSystemReviewLimitMax(input.system_review_limit_max_raises),
      "validation_failed",
      "自动加轮次数须为安全正整数或 null（未设置）",
    );
    ensure(
      input.role_rule_paths === undefined ||
        validRoleRulePaths(input.role_rule_paths),
      "validation_failed",
      "角色规则路径须为仓库相对路径，可用末尾 /** 表示子目录，或 null（未设置）",
    );
    ensure(
      input.system_merge_shadow_policy === undefined ||
        validMergeShadowPolicy(input.system_merge_shadow_policy),
      "validation_failed",
      "影子路径配置须包含角色规则和发布清单；路径仅接受相对路径或目录/**，不提供默认值",
    );
    const old = projectPreferences(state);
    ensure(
      input.independent_review_limit_delegation_max === undefined ||
        input.independent_review_limit_delegation_max === null ||
        validIndependentReviewDelegationMax(
          input.independent_review_limit_delegation_max,
        ),
      "validation_failed",
      `独立复核累计代批上限固定为 ${INDEPENDENT_REVIEW_DELEGATION_MAX} 次，或留空（不允许代批）`,
    );
    const independentMax =
      input.independent_review_limit_delegation_max === undefined
        ? old.independent_review_limit_delegation_max
        : input.independent_review_limit_delegation_max;
    ensure(
      !(
        input.independent_review_limit_delegation ??
        old.independent_review_limit_delegation
      ) || validIndependentReviewDelegationMax(independentMax),
      "validation_failed",
      "打开独立复核加轮授权前，须由人设置累计代批上限",
    );
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
      input.code_review_waits_for_precheck !== undefined ||
        input.system_review_limit_raise !== undefined ||
        input.system_review_limit_max_raises !== undefined ||
        input.role_rule_paths !== undefined ||
        input.system_merge_shadow !== undefined ||
        input.system_merge_shadow_policy !== undefined ||
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
        input.pm_confirm_human_decided_merges !== undefined ||
        input.pm_merge_confirmation !== undefined ||
        input.pm_confirm_role_rule_implementations !== undefined ||
        input.enable_reviewer_browser !== undefined ||
        input.board_collapsed_lanes !== undefined ||
        input.review_max_rounds !== undefined ||
        input.independent_review_max_rounds !== undefined ||
        input.independent_review_limit_delegation !== undefined ||
        input.independent_review_limit_delegation_max !== undefined ||
        input.tick_profile !== undefined,
      "validation_failed",
      "No preference supplied",
    );
    ensure(
      input.tick_profile === undefined ||
        typeof input.tick_profile === "boolean",
      "validation_failed",
      "tick_profile must be a boolean",
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
    ensure(
      input.pm_confirm_role_rule_implementations === undefined ||
        typeof input.pm_confirm_role_rule_implementations === "boolean",
      "validation_failed",
      "pm_confirm_role_rule_implementations must be a boolean",
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
      ...(input.code_review_waits_for_precheck !== undefined
        ? {
            code_review_waits_for_precheck:
              input.code_review_waits_for_precheck,
          }
        : {}),
      ...(input.system_review_limit_raise !== undefined
        ? { system_review_limit_raise: input.system_review_limit_raise }
        : {}),
      ...(input.system_review_limit_max_raises !== undefined
        ? {
            system_review_limit_max_raises:
              input.system_review_limit_max_raises,
          }
        : {}),
      ...(input.role_rule_paths !== undefined
        ? { role_rule_paths: input.role_rule_paths }
        : {}),
      ...(input.system_merge_shadow !== undefined
        ? { system_merge_shadow: input.system_merge_shadow }
        : {}),
      ...(input.system_merge_shadow_policy !== undefined
        ? { system_merge_shadow_policy: input.system_merge_shadow_policy }
        : {}),
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
      ...(input.pm_confirm_role_rule_implementations !== undefined
        ? {
            pm_confirm_role_rule_implementations:
              input.pm_confirm_role_rule_implementations,
          }
        : {}),
      ...(input.pm_confirm_human_decided_merges !== undefined
        ? {
            pm_confirm_human_decided_merges:
              input.pm_confirm_human_decided_merges,
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
      ...(input.tick_profile !== undefined
        ? { tick_profile: input.tick_profile }
        : {}),
      ...(input.independent_review_limit_delegation !== undefined
        ? {
            independent_review_limit_delegation:
              input.independent_review_limit_delegation,
          }
        : {}),
      ...(input.independent_review_limit_delegation_max !== undefined
        ? {
            independent_review_limit_delegation_max:
              input.independent_review_limit_delegation_max,
          }
        : {}),
    };
    const systemKeys = [
      "code_review_waits_for_precheck",
      "system_review_limit_raise",
      "system_auto_assign_verifiers",
      "system_reminders",
      "system_reminder_policy",
      "system_review_limit_max_raises",
      "role_rule_paths",
      "system_merge_shadow",
      "system_merge_shadow_policy",
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
          old[key] ??
            ([
              "system_reminder_policy",
              "system_merge_shadow_policy",
              "system_review_limit_max_raises",
              "role_rule_paths",
            ].includes(key)
              ? null
              : false),
        ) !==
        encodeSystemPreference(
          next[key] ??
            ([
              "system_reminder_policy",
              "system_merge_shadow_policy",
              "system_review_limit_max_raises",
              "role_rule_paths",
            ].includes(key)
              ? null
              : false),
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
    const roleRuleChanged =
      pmConfirmRoleRuleImplementations(old) !==
      pmConfirmRoleRuleImplementations(next);
    const humanDecidedMergeChanged =
      pmConfirmHumanDecidedMerges(old) !== pmConfirmHumanDecidedMerges(next);
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
    const tickProfileChanged = tickProfileOn(old) !== tickProfileOn(next);
    const independentChanged = (
      [
        "independent_review_limit_delegation",
        "independent_review_limit_delegation_max",
      ] as const
    ).filter(
      (key) =>
        (old[key] ??
          (key === "independent_review_limit_delegation" ? false : null)) !==
        (next[key] ??
          (key === "independent_review_limit_delegation" ? false : null)),
    );
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
      !humanDecidedMergeChanged &&
      !pmMergeChanged &&
      !roleRuleChanged &&
      !reviewerBrowserChanged &&
      !lanesChanged &&
      !reviewRoundsChanged.length &&
      !independentChanged.length &&
      !tickProfileChanged
    )
      return old;
    // Lane folding is a view setting: it is stored for every device but emits
    // no audit event, so toggling a lane never feeds the activity stream.
    d.put("project_preferences", next);
    for (const preference of independentChanged)
      d.emit("project_preferences_updated", undefined, {
        preference,
        old_value:
          old[preference] ??
          (preference === "independent_review_limit_delegation" ? false : null),
        new_value: next[preference] ?? null,
      });
    if (independentChanged.length)
      handoffUnauthorizedDecisions(
        d,
        "独立复核加轮授权已关闭或额度不足，此拍板须由人确认。",
      );
    for (const preference of systemChanged)
      d.emit("project_preferences_updated", undefined, {
        preference,
        old_value:
          old[preference] === undefined
            ? null
            : JSON.parse(JSON.stringify(old[preference])),
        new_value: JSON.parse(JSON.stringify(next[preference])),
      });
    if (
      old.code_review_waits_for_precheck === true &&
      next.code_review_waits_for_precheck === false
    )
      releaseCodeReviewPrecheckWaits(d);
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
    if (tickProfileChanged)
      d.emit("project_preferences_updated", undefined, {
        old_value: tickProfileOn(old),
        new_value: tickProfileOn(next),
        preference: "tick_profile",
      });
    if (delegationChanged) {
      d.emit("project_preferences_updated", undefined, {
        old_value: decisionDelegation(old),
        new_value: delegation,
        preference: "decision_delegation",
      });
      handoffUnauthorizedDecisions(d, "项目授权已关闭，此拍板转交给你。");
    }
    if (roleRuleChanged) {
      d.emit("project_preferences_updated", undefined, {
        preference: "pm_confirm_role_rule_implementations",
        old_value: pmConfirmRoleRuleImplementations(old),
        new_value: pmConfirmRoleRuleImplementations(next),
      });
      for (const card of d.list("cards")) syncRoleRuleMerge(d, card);
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
    if (humanDecidedMergeChanged) {
      d.emit("project_preferences_updated", undefined, {
        old_value: pmConfirmHumanDecidedMerges(old),
        new_value: pmConfirmHumanDecidedMerges(next),
        preference: "pm_confirm_human_decided_merges",
      });
      handoffUnauthorizedDecisions(
        d,
        "人已拍板的合并代确认授权已关闭，此合并确认转交给你。",
      );
    }
    if (humanDecidedMergeChanged || pmMergeChanged) syncHumanDecidedMerges(d);
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
