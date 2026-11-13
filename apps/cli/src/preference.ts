import {
  contextUsageThresholds,
  type DecisionCategory,
  decisionCategories,
  decisionDelegation,
  mergeConfirmSnoozeDefaultMinutes,
  mergeConfirmSnoozeMaxMinutes,
  mergeConfirmStallAfterMinutes,
  pmMergeConfirmation,
  projectPreferences,
  reviewerBrowserEnabled,
  setProjectPreferences,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { openStore } from "@cardigan/store";
import { CliError, EXIT } from "./errors.js";
import {
  announceDataDir,
  resolveActor,
  resolveProject,
  runCommand,
} from "./host.js";
import type { CliIo } from "./io.js";

const USAGE =
  "cardigan preference get context-handoff-remaining | set context-handoff-remaining <剩余百分比> | get context-restart-remaining | set context-restart-remaining <剩余百分比> | get auto-merge-after | set auto-merge-after <分钟|off> | get merge-confirm-stall-after | set merge-confirm-stall-after <分钟> | get merge-confirm-snooze-default | set merge-confirm-snooze-default <分钟> | get merge-confirm-snooze-max | set merge-confirm-snooze-max <分钟> | get decision-delegation | set decision-delegation <类别> <on|off> | get pm-merge-confirmation | set pm-merge-confirmation <on|off> | get reviewer-browser | set reviewer-browser <on|off> [--project <p>] [--data-dir <目录>]";
export function runPreferenceCommand(
  args: readonly string[],
  io: CliIo,
): number {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  const positions: string[] = [],
    flags: Record<string, string> = {};
  const fail = (): never => {
    throw new CliError(
      "偏好参数无效；上下文剩余百分比须大于 0 且小于 100，换会话比例须小于交接提醒比例；暂缓上限须为 60 到 10080 的整数分钟，其他时长须为 1 到 1440 的整数分钟；仅自动合并支持 off 关闭。",
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
  const contextKey =
    preference === "context-handoff-remaining"
      ? "context_handoff_remaining_pct"
      : preference === "context-restart-remaining"
        ? "context_restart_remaining_pct"
        : undefined;
  const delegation = preference === "decision-delegation";
  const pmMerge = preference === "pm-merge-confirmation";
  const browser = preference === "reviewer-browser";
  const toggleOnly = pmMerge || browser;
  const stall = preference === "merge-confirm-stall-after";
  const snooze = preference === "merge-confirm-snooze-default";
  const snoozeMax = preference === "merge-confirm-snooze-max";
  if (
    (!contextKey &&
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
    (contextKey || stall || snooze || snoozeMax) &&
    action === "set" &&
    raw === "off"
  )
    fail();
  if (
    action === "set" &&
    !contextKey &&
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
    (!decisionCategories.includes(raw as DecisionCategory) ||
      !["on", "off"].includes(toggle ?? ""))
  )
    fail();
  if (toggleOnly && action === "set" && !["on", "off"].includes(raw ?? ""))
    fail();
  const store = openStore({ dataDir: announceDataDir(io, flags["data-dir"]) });
  try {
    const project = resolveProject(store, io, flags.project);
    const preferences =
      action === "set"
        ? runCommand(store, {
            operation: "设置项目偏好",
            target: `${project} ${preference}`,
            project_id: project,
            actor: resolveActor(io, project, store),
            reduce: (s, a, ports) =>
              setProjectPreferences(
                s,
                a,
                contextKey
                  ? { [contextKey]: Number(minutes) }
                  : delegation
                    ? {
                        decision_delegation: {
                          [raw as DecisionCategory]: toggle === "on",
                        },
                      }
                    : pmMerge
                      ? { pm_merge_confirmation: raw === "on" }
                      : browser
                        ? { enable_reviewer_browser: raw === "on" }
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
                              : { auto_merge_after_minutes: minutes },
                ports,
              ),
          })
        : store.uow.read((tx) =>
            projectPreferences(loadCommandState(tx, project)),
          );
    io.stdout(
      contextKey
        ? `${preference}: ${contextUsageThresholds(preferences)[contextKey === "context_handoff_remaining_pct" ? "handoff" : "restart"]}`
        : delegation
          ? Object.entries(decisionDelegation(preferences))
              .map(
                ([category, enabled]) =>
                  `${category}: ${enabled ? "on (PM 代拍)" : "off (由人确认)"}`,
              )
              .join("\n")
          : pmMerge
            ? `pm-merge-confirmation: ${pmMergeConfirmation(preferences) ? "on (PM 代确认合并)" : "off (由人确认)"}`
            : browser
              ? `reviewer-browser: ${reviewerBrowserEnabled(preferences) ? "on (界面卡的截图核对须由独立复核员审核通过，PM 才能代确认)" : "off (灰度中，截图核对由 PM Office 或人核实)"}`
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
