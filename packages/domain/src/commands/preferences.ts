import type { Actor } from "../entities.js";
import {
  FLOW_VERSION_MAX,
  projectFlowVersion,
  validFlowVersion,
} from "../flow.js";
import {
  autoMergePaused,
  contextUsageThresholds,
  crossCardRead,
  type DelegationCategory,
  decisionDelegation,
  delegationCategories,
  highRiskPaths,
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
  validAutoSecurityPaths,
  validContextPercentage,
  validIndependentReviewDelegationMax,
  validMergeConfirmSnoozeMaxMinutes,
  validMergeConfirmStallMinutes,
  validMergePathList,
  validMergeShadowPolicy,
  validReviewMaxRounds,
  validSystemReminderPolicy,
} from "../preferences.js";
import {
  type SharedFilesAccess,
  validSharedFilesAccess,
} from "../shared-files.js";
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
import {
  assignDecision,
  handoffUnauthorizedDecisions,
  mergeNeedsHuman,
} from "./delegation.js";
import {
  syncHumanDecidedMerges,
  syncRoleRuleMerge,
  syncScreenshotMerge,
  syncSystemMerge,
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
    cross_card_read?: boolean;
    /** C-685: per-role narrowing of the shared file library; `{}` restores the default. */
    shared_files_access?: Readonly<Record<string, SharedFilesAccess>>;
    auto_merge_paused?: boolean;
    auto_merge?: "off" | "on";
    machine_preference?: readonly string[];
    high_risk_paths?: readonly string[];
    auto_security_paths?: readonly string[];
    flow_version?: number;
    system_review_limit_raise?: boolean;
    system_review_limit_max_raises?: number | null;
    role_rule_paths?: readonly string[] | null;
    system_merge_shadow?: boolean;
    system_merge_shadow_policy?: MergeShadowPolicy | null;
    system_auto_assign_verifiers?: boolean;
    system_reminders?: boolean;
    pm_owner_messages?: boolean;
    system_reminder_policy?: SystemReminderPolicy | null;
    auto_merge_after_minutes?: number | null;
    context_handoff_remaining_pct?: number;
    context_restart_remaining_pct?: number;
    merge_confirm_stall_after_minutes?: number;
    merge_confirm_snooze_default_minutes?: number;
    merge_confirm_snooze_max_minutes?: number;
    decision_delegation?: Partial<Record<DelegationCategory, boolean>>;
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
      input.cross_card_read === undefined ||
        typeof input.cross_card_read === "boolean",
      "validation_failed",
      "cross_card_read must be a boolean",
    );
    ensure(
      input.shared_files_access === undefined ||
        validSharedFilesAccess(input.shared_files_access),
      "validation_failed",
      "shared_files_access 须为 角色→read_write|read|none 的映射（* 表示其余角色）",
    );
    ensure(
      input.auto_merge_paused === undefined ||
        typeof input.auto_merge_paused === "boolean",
      "validation_failed",
      "auto_merge_paused must be a boolean",
    );
    ensure(
      input.auto_merge === undefined ||
        ["off", "on"].includes(input.auto_merge),
      "validation_failed",
      "auto_merge must be off or on",
    );
    ensure(
      input.machine_preference === undefined ||
        (Array.isArray(input.machine_preference) &&
          input.machine_preference.every(
            (id) =>
              typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(id),
          ) &&
          new Set(input.machine_preference).size ===
            input.machine_preference.length),
      "validation_failed",
      "机器偏好须为不重复的机器编号数组",
    );
    ensure(
      input.high_risk_paths === undefined ||
        validMergePathList(input.high_risk_paths),
      "validation_failed",
      "high_risk_paths must be repository path patterns",
    );
    ensure(
      input.flow_version === undefined || validFlowVersion(input.flow_version),
      "validation_failed",
      `流程版本须为 1 到 ${FLOW_VERSION_MAX} 的整数，后续流程尚未开放`,
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
      "system_review_limit_raise",
      "system_merge_shadow",
      "pm_confirm_human_decided_merges",
      "system_auto_assign_verifiers",
      "system_reminders",
      "pm_owner_messages",
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
      "影子路径配置须包含角色规则和发布清单；路径仅接受相对路径、目录/** 或末段前缀*，不提供默认值",
    );
    ensure(
      input.auto_security_paths === undefined ||
        validAutoSecurityPaths(input.auto_security_paths),
      "validation_failed",
      "安全路径须为仓库相对路径、目录/** 或末段前缀*，且必须包含 .github/**",
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
      input.auto_merge !== undefined ||
        input.machine_preference !== undefined ||
        input.high_risk_paths !== undefined ||
        input.cross_card_read !== undefined ||
        input.shared_files_access !== undefined ||
        input.auto_merge_paused !== undefined ||
        input.auto_security_paths !== undefined ||
        input.flow_version !== undefined ||
        input.system_review_limit_raise !== undefined ||
        input.system_review_limit_max_raises !== undefined ||
        input.role_rule_paths !== undefined ||
        input.system_merge_shadow !== undefined ||
        input.system_merge_shadow_policy !== undefined ||
        input.system_auto_assign_verifiers !== undefined ||
        input.system_reminders !== undefined ||
        input.pm_owner_messages !== undefined ||
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
        delegationCategories.includes(category as DelegationCategory) &&
          typeof enabled === "boolean",
        "validation_failed",
        "Unknown decision category or authorization",
      );

      delegation[category as DelegationCategory] = enabled;
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
      ...(input.machine_preference
        ? { machine_preference: [...input.machine_preference] }
        : {}),
      ...(input.auto_merge !== undefined
        ? { auto_merge: input.auto_merge }
        : {}),
      ...(input.high_risk_paths !== undefined
        ? { high_risk_paths: [...input.high_risk_paths] }
        : {}),
      ...(input.cross_card_read !== undefined
        ? { cross_card_read: input.cross_card_read }
        : {}),
      ...(input.shared_files_access !== undefined
        ? { shared_files_access: { ...input.shared_files_access } }
        : {}),
      ...(input.auto_merge_paused !== undefined
        ? { auto_merge_paused: input.auto_merge_paused }
        : {}),
      ...(input.auto_security_paths !== undefined
        ? { auto_security_paths: [...input.auto_security_paths] }
        : {}),
      ...(input.flow_version !== undefined
        ? { flow_version: input.flow_version }
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
      ...(input.pm_owner_messages !== undefined
        ? { pm_owner_messages: input.pm_owner_messages }
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
    ensure(
      (next.flow_version ?? 1) < 4 ||
        (input.flow_version === undefined &&
          input.system_merge_shadow_policy === undefined) ||
        validMergePathList(next.system_merge_shadow_policy?.release_paths),
      "validation_failed",
      "启用系统合并前须由人显式设置发布路径（可为空数组）",
    );
    const systemKeys = [
      "auto_merge",
      "machine_preference",
      "high_risk_paths",
      "auto_security_paths",
      "system_review_limit_raise",
      "system_auto_assign_verifiers",
      "system_reminders",
      "pm_owner_messages",
      "system_reminder_policy",
      "system_review_limit_max_raises",
      "role_rule_paths",
      "system_merge_shadow",
      "system_merge_shadow_policy",
      "shared_files_access",
    ] as const;
    const encodeSystemPreference = (value: unknown) =>
      JSON.stringify(
        value,
        value && typeof value === "object"
          ? Object.keys(value).sort()
          : undefined,
      );
    const systemChanged = systemKeys.filter((key) =>
      key === "auto_merge"
        ? old.auto_merge !== next.auto_merge
        : encodeSystemPreference(
            old[key] ??
              (key === "high_risk_paths" ? highRiskPaths(old) : undefined) ??
              ([
                "system_reminder_policy",
                "system_merge_shadow_policy",
                "system_review_limit_max_raises",
                "role_rule_paths",
                "shared_files_access",
              ].includes(key)
                ? null
                : false),
          ) !==
          encodeSystemPreference(
            next[key] ??
              (key === "high_risk_paths" ? highRiskPaths(next) : undefined) ??
              ([
                "system_reminder_policy",
                "system_merge_shadow_policy",
                "system_review_limit_max_raises",
                "role_rule_paths",
                "shared_files_access",
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
    const delegationChanged = delegationCategories.some(
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
    const crossReadChanged = crossCardRead(old) !== crossCardRead(next);
    const pauseChanged = autoMergePaused(old) !== autoMergePaused(next);
    const flowChanged = projectFlowVersion(old) !== projectFlowVersion(next);
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
      !tickProfileChanged &&
      !flowChanged &&
      !pauseChanged &&
      !crossReadChanged
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
    if (crossReadChanged)
      d.emit("project_preferences_updated", undefined, {
        old_value: crossCardRead(old),
        new_value: crossCardRead(next),
        preference: "cross_card_read",
      });
    if (pauseChanged)
      d.emit("project_preferences_updated", undefined, {
        old_value: autoMergePaused(old),
        new_value: autoMergePaused(next),
        preference: "auto_merge_paused",
      });
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
    if (flowChanged)
      d.emit("project_preferences_updated", undefined, {
        old_value: projectFlowVersion(old),
        new_value: projectFlowVersion(next),
        preference: "flow_version",
      });
    if (
      flowChanged ||
      systemChanged.some((key) =>
        [
          "system_merge_shadow_policy",
          "auto_merge",
          "high_risk_paths",
        ].includes(key),
      )
    )
      for (const card of d.list("cards")) syncSystemMerge(d, card);
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
      syncHumanDecidedMerges(d);
      for (const q of d.list("decisions")) {
        if (
          q.trigger !== "merge_confirmation" ||
          q.status !== "open" ||
          q.decider !== "human" ||
          !q.card_id ||
          !mergeNeedsHuman(
            d.list("decisions"),
            d.list("cards"),
            q.card_id,
            old,
            d.state.events,
          )
        )
          continue;
        const nextDecision = assignDecision(d, q);
        if (nextDecision.decider !== "role:pm") continue;
        d.put("decisions", nextDecision);
        d.emit(
          "decision_requested",
          q.card_id,
          {
            decision_id: q.id,
            previous_decider: "human",
            delegation_authority: nextDecision.delegation_authority ?? null,
            affected_work_items: [],
          },
          {
            type: "decision_request",
            decision_id: q.id,
            body: "已按你刚开启的类别授权，将待处理合并确认转给 PM。",
          },
        );
      }
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
