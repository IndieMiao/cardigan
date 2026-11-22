import {
  autoSecurityPaths,
  contextUsageThresholds,
  type DelegationCategory,
  decisionDelegation,
  delegationCategories,
  FLOW_VERSION_MAX,
  highRiskPaths,
  INDEPENDENT_REVIEW_DELEGATION_MAX,
  independentReviewMaxRounds,
  type MergeShadowPolicy,
  mergeConfirmSnoozeDefaultMinutes,
  mergeConfirmSnoozeMaxMinutes,
  mergeConfirmStallAfterMinutes,
  type ProjectId,
  pmConfirmHumanDecidedMerges,
  pmConfirmRoleRuleImplementations,
  pmMergeConfirmation,
  projectFlowVersion,
  projectPreferences,
  REVIEW_MAX_ROUNDS_CEILING,
  reviewerBrowserEnabled,
  reviewMaxRounds,
  setProjectPreferences,
  tickProfileOn,
  validAutoSecurityPaths,
  validFlowVersion,
  validIndependentReviewDelegationMax,
  validMergePathList,
  validRoleRulePaths,
  validSystemReviewLimitMax,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { openStore, type Store } from "@cardigan/store";
import { CliError, EXIT } from "./errors.js";
import {
  announceDataDir,
  loadProjectMergeGate,
  resolveActor,
  resolveProject,
  runCommand,
} from "./host.js";
import type { CliIo } from "./io.js";

const USAGE =
  "cardigan preference get machine-preference | set machine-preference <JSON机器编号数组> | get auto-merge | set auto-merge <on|off> | get high-risk-paths | set high-risk-paths <JSON路径数组> | get cross-card-read | set cross-card-read <on|off> | get auto-merge-paused | set auto-merge-paused <on|off> | get flow-version | set flow-version <版本> | get auto-security-paths | set auto-security-paths <JSON路径数组> | get system-merge-shadow | set system-merge-shadow <on|off> | get system-merge-shadow-policy | set system-merge-shadow-policy <JSON|null> | get context-handoff-remaining | set context-handoff-remaining <剩余百分比> | get context-restart-remaining | set context-restart-remaining <剩余百分比> | get auto-merge-after | set auto-merge-after <分钟|off> | get merge-confirm-stall-after | set merge-confirm-stall-after <分钟> | get merge-confirm-snooze-default | set merge-confirm-snooze-default <分钟> | get merge-confirm-snooze-max | set merge-confirm-snooze-max <分钟> | get decision-delegation | set decision-delegation <类别> <on|off> | get pm-confirm-role-rule-implementations | set pm-confirm-role-rule-implementations <on|off> | get pm-confirm-human-decided-merges | set pm-confirm-human-decided-merges <on|off> | get pm-merge-confirmation | set pm-merge-confirmation <on|off> | get reviewer-browser | set reviewer-browser <on|off> | get review-max-rounds | set review-max-rounds <轮数> | get independent-review-max-rounds | set independent-review-max-rounds <轮数> | get independent-review-limit-delegation | set independent-review-limit-delegation <on|off> | get independent-review-limit-delegation-max | set independent-review-limit-delegation-max <次数|off> | get tick-profile | set tick-profile <on|off> | get system-review-limit-raise | set system-review-limit-raise <on|off> | get system-review-limit-max-raises | set system-review-limit-max-raises <次数|off> | get role-rule-paths | set role-rule-paths <JSON路径数组|off> [--project <p>] [--data-dir <目录>]";
export async function runPreferenceCommand(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  const positions: string[] = [],
    flags: Record<string, string> = {};
  const fail = (): never => {
    throw new CliError(
      `偏好参数无效；上下文剩余百分比须大于 0 且小于 100，换会话比例须小于交接提醒比例；暂缓上限须为 60 到 10080 的整数分钟，其他时长须为 1 到 1440 的整数分钟；审核轮数上限须为 1 到 ${REVIEW_MAX_ROUNDS_CEILING} 的整数；自动合并、自动加轮次数和角色路径支持 off 清除；自动加轮次数须为安全正整数，角色路径须为 JSON 数组（相对路径，可用末尾 /**）。`,
      EXIT.usage,
      [USAGE],
    );
  };
  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string;
    if (!token.startsWith("--")) {
      positions.push(token);
      continue;
    }
    const name = token.slice(2),
      value = args[++i];
    if (
      !["project", "data-dir"].includes(name) ||
      flags[name] !== undefined ||
      !value?.trim() ||
      value.startsWith("--")
    )
      fail();
    flags[name] = value as string;
  }
  const [action, preference, raw, toggle] = positions;
  // Preference changes can reassign open confirmations in the same transaction.
  async function writePreferences(
    store: Store,
    project: ProjectId,
    operation: string,
    patch: Parameters<typeof setProjectPreferences>[2],
  ) {
    const actor = resolveActor(io, project, store);
    const gate = await loadProjectMergeGate(
      store,
      project,
      io,
      flags["data-dir"],
    );
    return runCommand(store, {
      operation,
      target: `${project} ${preference}`,
      project_id: project,
      actor,
      reduce: (s, a, ports) =>
        setProjectPreferences(
          {
            ...s,
            project_settings: {
              ...s.project_settings,
              merge_gate_enabled: gate.status !== "disabled",
            },
          },
          a,
          patch,
          ports,
        ),
    });
  }
  if (preference === "flow-version") {
    if (
      !["get", "set"].includes(action ?? "") ||
      positions.length !== (action === "get" ? 2 : 3)
    )
      fail();
    const flow_version = Number(raw);
    if (
      action === "set" &&
      (!/^\d+$/.test(raw ?? "") || !validFlowVersion(flow_version))
    )
      throw new CliError(
        `流程版本须为 1 到 ${FLOW_VERSION_MAX} 的整数，后续流程尚未开放`,
        EXIT.usage,
      );
    const store = openStore({
      dataDir: announceDataDir(io, flags["data-dir"]),
    });
    try {
      const project = resolveProject(store, io, flags.project);
      const pref =
        action === "set"
          ? await writePreferences(store, project, "设置新卡流程版本", {
              flow_version,
            })
          : store.uow.read((tx) =>
              projectPreferences(loadCommandState(tx, project)),
            );
      io.stdout(
        `flow-version: ${projectFlowVersion(pref)} (只影响之后新建的卡片)`,
      );
      return EXIT.ok;
    } finally {
      store.close();
    }
  }
  const systemKey =
    preference === "machine-preference"
      ? "machine_preference"
      : preference === "auto-merge"
        ? "auto_merge"
        : preference === "high-risk-paths"
          ? "high_risk_paths"
          : preference === "cross-card-read"
            ? "cross_card_read"
            : preference === "auto-merge-paused"
              ? "auto_merge_paused"
              : preference === "auto-security-paths"
                ? "auto_security_paths"
                : preference === "system-review-limit-raise"
                  ? "system_review_limit_raise"
                  : preference === "system-review-limit-max-raises"
                    ? "system_review_limit_max_raises"
                    : preference === "role-rule-paths"
                      ? "role_rule_paths"
                      : undefined;
  if (systemKey) {
    if (
      !["get", "set"].includes(action ?? "") ||
      positions.length !== (action === "get" ? 2 : 3)
    )
      fail();
    let setting: "off" | "on" | boolean | number | readonly string[] | null =
      null;
    if (action === "set") {
      if (systemKey === "auto_merge") {
        if (raw !== "on" && raw !== "off") fail();
        setting = raw as "on" | "off";
      } else if (
        systemKey === "system_review_limit_raise" ||
        systemKey === "cross_card_read" ||
        systemKey === "auto_merge_paused"
      ) {
        if (!["on", "off"].includes(raw ?? "")) fail();
        setting = raw === "on";
      } else if (systemKey === "system_review_limit_max_raises") {
        setting = raw === "off" ? null : Number(raw);
        if (
          (raw !== "off" && !/^\d+$/.test(raw ?? "")) ||
          !validSystemReviewLimitMax(setting)
        )
          fail();
      } else {
        try {
          setting = raw === "off" ? null : JSON.parse(raw ?? "");
        } catch {
          fail();
        }
        if (
          systemKey === "machine_preference"
            ? !Array.isArray(setting)
            : systemKey === "high_risk_paths"
              ? !validMergePathList(setting)
              : systemKey === "auto_security_paths"
                ? !validAutoSecurityPaths(setting)
                : !validRoleRulePaths(setting)
        )
          fail();
      }
    }
    const store = openStore({
      dataDir: announceDataDir(io, flags["data-dir"]),
    });
    try {
      const project = resolveProject(store, io, flags.project);
      const pref =
        action === "set"
          ? await writePreferences(store, project, "设置系统审核偏好", {
              [systemKey]: setting,
            })
          : store.uow.read((tx) =>
              projectPreferences(loadCommandState(tx, project)),
            );
      io.stdout(
        systemKey === "auto_merge"
          ? `auto-merge: ${pref.auto_merge ?? "off"}`
          : systemKey === "machine_preference"
            ? `machine-preference: ${JSON.stringify(pref.machine_preference ?? [])}`
            : systemKey === "high_risk_paths"
              ? `high-risk-paths: ${JSON.stringify(highRiskPaths(pref))}`
              : systemKey === "cross_card_read"
                ? `cross-card-read: ${pref.cross_card_read !== false ? "on" : "off"}`
                : systemKey === "auto_merge_paused"
                  ? `auto-merge-paused: ${pref.auto_merge_paused === true ? "on" : "off"}`
                  : `${preference}: ${JSON.stringify(systemKey === "auto_security_paths" ? autoSecurityPaths(pref) : (pref[systemKey] ?? (systemKey === "system_review_limit_raise" ? false : null)))}`,
      );
      return EXIT.ok;
    } finally {
      store.close();
    }
  }
  const contextKey =
    preference === "context-handoff-remaining"
      ? "context_handoff_remaining_pct"
      : preference === "context-restart-remaining"
        ? "context_restart_remaining_pct"
        : undefined;
  const delegation = preference === "decision-delegation";
  const roleImplementations =
    preference === "pm-confirm-role-rule-implementations";
  const humanDecidedMerge = preference === "pm-confirm-human-decided-merges";
  const pmMerge = preference === "pm-merge-confirmation";
  const browser = preference === "reviewer-browser";
  // C-265: loop timing, picked up by the running server on its next tick.
  const tickProfile = preference === "tick-profile";
  const shadow = preference === "system-merge-shadow";
  const shadowPolicy = preference === "system-merge-shadow-policy";
  let shadowPolicyValue: MergeShadowPolicy | null = null;
  if (shadowPolicy && action === "set") {
    try {
      shadowPolicyValue = JSON.parse(raw ?? "") as MergeShadowPolicy | null;
    } catch {
      fail();
    }
  }
  const independentDelegation =
    preference === "independent-review-limit-delegation";
  const independentMax =
    preference === "independent-review-limit-delegation-max";
  const toggleOnly =
    roleImplementations ||
    humanDecidedMerge ||
    pmMerge ||
    browser ||
    tickProfile ||
    shadow ||
    independentDelegation;
  const stall = preference === "merge-confirm-stall-after";
  const snooze = preference === "merge-confirm-snooze-default";
  const snoozeMax = preference === "merge-confirm-snooze-max";
  // C-253: review limits of verifiers created afterwards.
  const roundsKey =
    preference === "review-max-rounds"
      ? "review_max_rounds"
      : preference === "independent-review-max-rounds"
        ? "independent_review_max_rounds"
        : undefined;
  if (
    (!contextKey &&
      !roundsKey &&
      !shadowPolicy &&
      !independentMax &&
      !delegation &&
      !toggleOnly &&
      !stall &&
      !snooze &&
      !snoozeMax &&
      preference !== "auto-merge-after") ||
    !["get", "set"].includes(action ?? "") ||
    positions.length !== (action === "get" ? 2 : delegation ? 4 : 3)
  )
    fail();
  const minutes = raw === "off" ? null : Number(raw);
  if (
    (contextKey || roundsKey || stall || snooze || snoozeMax) &&
    action === "set" &&
    raw === "off"
  )
    fail();
  if (
    roundsKey &&
    action === "set" &&
    (!/^\d+$/.test(raw ?? "") ||
      Number(raw) < 1 ||
      Number(raw) > REVIEW_MAX_ROUNDS_CEILING)
  )
    fail();
  if (
    action === "set" &&
    !contextKey &&
    !roundsKey &&
    !shadowPolicy &&
    !independentMax &&
    !delegation &&
    !toggleOnly &&
    raw !== "off" &&
    (!/^\d+$/.test(raw ?? "") ||
      !Number.isInteger(minutes) ||
      Number(minutes) < (snoozeMax ? 60 : 1) ||
      Number(minutes) > (snoozeMax ? 10080 : 1440))
  )
    fail();
  if (
    contextKey &&
    action === "set" &&
    (!/^\d+(?:\.\d+)?$/.test(raw ?? "") ||
      !Number.isFinite(minutes) ||
      Number(minutes) <= 0 ||
      Number(minutes) >= 100)
  )
    fail();
  if (
    delegation &&
    action === "set" &&
    (!delegationCategories.includes(raw as DelegationCategory) ||
      !["on", "off"].includes(toggle ?? ""))
  )
    fail();
  if (toggleOnly && action === "set" && !["on", "off"].includes(raw ?? ""))
    fail();
  if (
    independentMax &&
    action === "set" &&
    raw !== "off" &&
    (!/^\d+$/.test(raw ?? "") ||
      !validIndependentReviewDelegationMax(Number(raw)))
  )
    fail();
  const store = openStore({ dataDir: announceDataDir(io, flags["data-dir"]) });
  try {
    const project = resolveProject(store, io, flags.project);
    const preferences =
      action === "set"
        ? await writePreferences(
            store,
            project,
            "设置项目偏好",
            shadow
              ? { system_merge_shadow: raw === "on" }
              : shadowPolicy
                ? { system_merge_shadow_policy: shadowPolicyValue }
                : independentDelegation
                  ? {
                      independent_review_limit_delegation: raw === "on",
                      ...(raw === "on"
                        ? {
                            independent_review_limit_delegation_max:
                              INDEPENDENT_REVIEW_DELEGATION_MAX,
                          }
                        : {}),
                    }
                  : independentMax
                    ? {
                        independent_review_limit_delegation_max:
                          raw === "off" ? null : Number(raw),
                      }
                    : contextKey
                      ? { [contextKey]: Number(minutes) }
                      : roundsKey
                        ? { [roundsKey]: Number(raw) }
                        : delegation
                          ? {
                              decision_delegation: {
                                [raw as DelegationCategory]: toggle === "on",
                              },
                            }
                          : roleImplementations
                            ? {
                                pm_confirm_role_rule_implementations:
                                  raw === "on",
                              }
                            : humanDecidedMerge
                              ? {
                                  pm_confirm_human_decided_merges: raw === "on",
                                }
                              : pmMerge
                                ? { pm_merge_confirmation: raw === "on" }
                                : browser
                                  ? {
                                      enable_reviewer_browser: raw === "on",
                                    }
                                  : tickProfile
                                    ? { tick_profile: raw === "on" }
                                    : stall
                                      ? {
                                          merge_confirm_stall_after_minutes:
                                            Number(minutes),
                                        }
                                      : snooze
                                        ? {
                                            merge_confirm_snooze_default_minutes:
                                              Number(minutes),
                                          }
                                        : snoozeMax
                                          ? {
                                              merge_confirm_snooze_max_minutes:
                                                Number(minutes),
                                            }
                                          : {
                                              auto_merge_after_minutes: minutes,
                                            },
          )
        : store.uow.read((tx) =>
            projectPreferences(loadCommandState(tx, project)),
          );
    io.stdout(
      shadow
        ? `system-merge-shadow: ${preferences.system_merge_shadow === true ? "on" : "off"} (只记录，不合并)`
        : shadowPolicy
          ? JSON.stringify(preferences.system_merge_shadow_policy ?? null)
          : independentDelegation
            ? `independent-review-limit-delegation: ${preferences.independent_review_limit_delegation === true ? "on" : "off"} (加轮不等于复核通过或合并)`
            : independentMax
              ? `independent-review-limit-delegation-max: ${preferences.independent_review_limit_delegation_max ?? "未设置，不允许代批"} (每项累计，重新开启不重置)`
              : contextKey
                ? `${preference}: ${contextUsageThresholds(preferences)[contextKey === "context_handoff_remaining_pct" ? "handoff" : "restart"]}`
                : roundsKey
                  ? `${preference}: ${roundsKey === "review_max_rounds" ? reviewMaxRounds(preferences) : independentReviewMaxRounds(preferences)} (只影响之后新建的审核项)`
                  : delegation
                    ? Object.entries(decisionDelegation(preferences))
                        .map(
                          ([category, enabled]) =>
                            `${category}: ${enabled ? "on (PM 代拍)" : "off (由人确认)"}`,
                        )
                        .join("\n")
                    : roleImplementations
                      ? `pm-confirm-role-rule-implementations: ${pmConfirmRoleRuleImplementations(preferences) ? "on" : "off"} (仅已拍角色正文，权限与审核规则仍交人)`
                      : humanDecidedMerge
                        ? `pm-confirm-human-decided-merges: ${pmConfirmHumanDecidedMerges(preferences) ? "on (人已拍板的范围和权限改动可由 PM 核对后确认合并)" : "off (范围和权限改动仍由人确认合并)"}`
                        : pmMerge
                          ? `pm-merge-confirmation: ${pmMergeConfirmation(preferences) ? "on (PM 代确认合并)" : "off (由人确认)"}`
                          : browser
                            ? `reviewer-browser: ${reviewerBrowserEnabled(preferences) ? "on (界面卡的截图核对须由独立复核员审核通过，PM 才能代确认)" : "off (灰度中，截图核对由 PM Office 或人核实)"}`
                            : tickProfile
                              ? `tick-profile: ${tickProfileOn(preferences) ? "on (server 在下一个循环周期开始计时)" : "off (CARDIGAN_TICK_PROFILE=1 仍可强制打开)"}`
                              : stall
                                ? `merge-confirm-stall-after: ${mergeConfirmStallAfterMinutes(preferences)}`
                                : snooze
                                  ? `merge-confirm-snooze-default: ${mergeConfirmSnoozeDefaultMinutes(preferences)}`
                                  : snoozeMax
                                    ? `merge-confirm-snooze-max: ${mergeConfirmSnoozeMaxMinutes(preferences)}`
                                    : `auto-merge-after: ${preferences.auto_merge_after_minutes ?? "off"}`,
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}
