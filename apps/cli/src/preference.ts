import {
  type DecisionCategory,
  decisionCategories,
  decisionDelegation,
  pmMergeConfirmation,
  projectPreferences,
  setProjectPreferences,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { openStore } from "@cardigan/store";
import { CliError, EXIT } from "./errors.js";
import {
  announceDataDir,
  humanActor,
  resolveProject,
  runCommand,
} from "./host.js";
import type { CliIo } from "./io.js";

const USAGE =
  "cardigan preference get auto-merge-after | set auto-merge-after <分钟|off> | get decision-delegation | set decision-delegation <类别> <on|off> | get pm-merge-confirmation | set pm-merge-confirmation <on|off> [--project <p>] [--data-dir <目录>]";
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
      "偏好参数无效；分钟须为 1 到 1440 的整数，off 表示关闭。",
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
  const delegation = preference === "decision-delegation";
  const pmMerge = preference === "pm-merge-confirmation";
  if (
    (!delegation && !pmMerge && preference !== "auto-merge-after") ||
    !["get", "set"].includes(action ?? "") ||
    positions.length !== (action === "get" ? 2 : delegation ? 4 : 3)
  )
    fail();
  const minutes = raw === "off" ? null : Number(raw);
  if (
    action === "set" &&
    !delegation &&
    !pmMerge &&
    raw !== "off" &&
    (!/^\d+$/.test(raw ?? "") ||
      !Number.isInteger(minutes) ||
      Number(minutes) < 1 ||
      Number(minutes) > 1440)
  )
    fail();
  if (
    delegation &&
    action === "set" &&
    (!decisionCategories.includes(raw as DecisionCategory) ||
      !["on", "off"].includes(toggle ?? ""))
  )
    fail();
  if (pmMerge && action === "set" && !["on", "off"].includes(raw ?? "")) fail();
  const store = openStore({ dataDir: announceDataDir(io, flags["data-dir"]) });
  try {
    const project = resolveProject(store, io, flags.project);
    const preferences =
      action === "set"
        ? runCommand(store, {
            operation: "设置项目偏好",
            target: `${project} ${preference}`,
            project_id: project,
            actor: humanActor(project),
            reduce: (s, a, ports) =>
              setProjectPreferences(
                s,
                a,
                delegation
                  ? {
                      decision_delegation: {
                        [raw as DecisionCategory]: toggle === "on",
                      },
                    }
                  : pmMerge
                    ? { pm_merge_confirmation: raw === "on" }
                    : { auto_merge_after_minutes: minutes },
                ports,
              ),
          })
        : store.uow.read((tx) =>
            projectPreferences(loadCommandState(tx, project)),
          );
    io.stdout(
      delegation
        ? Object.entries(decisionDelegation(preferences))
            .map(
              ([category, enabled]) =>
                `${category}: ${enabled ? "on (PM 代拍)" : "off (由人确认)"}`,
            )
            .join("\n")
        : pmMerge
          ? `pm-merge-confirmation: ${pmMergeConfirmation(preferences) ? "on (PM 代确认合并)" : "off (由人确认)"}`
          : `auto-merge-after: ${preferences.auto_merge_after_minutes ?? "off"}`,
    );
    return EXIT.ok;
  } finally {
    store.close();
  }
}
