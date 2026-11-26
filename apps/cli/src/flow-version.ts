import {
  FLOW_VERSION_MAX,
  parseId,
  upgradeCardFlow,
  validFlowVersion,
} from "@cardigan/domain";
import { assignmentTokenTools } from "@cardigan/host";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import { openStore } from "@cardigan/store";
import { requireCliTool } from "./command-access.js";
import { CliError, EXIT, formatCommandError } from "./errors.js";
import {
  announceDataDir,
  resolveActor,
  resolveProject,
  systemClock,
  warmCommandState,
} from "./host.js";
import type { CliIo } from "./io.js";

export function runFlowUpgrade(args: readonly string[], io: CliIo): number {
  const ids: string[] = [];
  const flags: Record<string, string> = {};
  const fail = (message: string): never => {
    throw new CliError(message, EXIT.usage, [
      "cardigan card flow-upgrade <C-n…> --to <N> [--project <p>] [--data-dir <目录>]",
    ]);
  };
  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string;
    if (!token.startsWith("--")) {
      ids.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = token.slice(2, eq < 0 ? undefined : eq);
    const value = eq < 0 ? args[++i] : token.slice(eq + 1);
    if (
      !["to", "project", "data-dir"].includes(name) ||
      flags[name] !== undefined ||
      !value?.trim() ||
      value.startsWith("--")
    )
      fail(`不合法或重复的选项：--${name}`);
    flags[name] = value as string;
  }
  const cards = ids.map((raw) => {
    const parsed = parseId("card", raw);
    if (!parsed.ok) return fail(`卡片编号不合法：${raw}`);
    return parsed.value.id;
  });
  if (!cards.length || new Set(cards).size !== cards.length)
    fail("请提供至少一个不重复的卡片编号");
  const to = Number(flags.to);
  if (!/^\d+$/.test(flags.to ?? "") || !validFlowVersion(to))
    fail(`--to 须为 1 到 ${FLOW_VERSION_MAX} 的整数，后续流程尚未开放`);
  const store = openStore({ dataDir: announceDataDir(io, flags["data-dir"]) });
  try {
    const project = resolveProject(store, io, flags.project);
    const actor = resolveActor(io, project, store);
    requireCliTool(actor, "card flow-upgrade");
    // Validate and persist the whole batch under one fresh write lock.
    warmCommandState(store, project);
    store.uow.run((tx) => {
      for (const card_id of cards) {
        const state = loadCommandState(tx, project);
        const assignment_tool_scopes = Object.fromEntries(
          state.assignments
            .filter(
              (a) =>
                a.scope === "work_item" &&
                state.work_items.some(
                  (w) =>
                    w.card_id === card_id &&
                    w.assignment_id === a.id &&
                    w.kind === "produce",
                ),
            )
            .map((a) => {
              const role = state.roles.find(
                (r) =>
                  r.role_id === a.role_id && r.role_version === a.role_version,
              );
              return [
                a.id,
                role && !a.role_upgrade
                  ? assignmentTokenTools(tx, project, a.id, role)
                  : [],
              ];
            }),
        );
        const result = upgradeCardFlow(
          { ...state, assignment_tool_scopes },
          actor,
          { card_id, to },
          { clock: systemClock, ids: tx.ids },
        );
        if (!result.ok)
          throw new CliError(
            formatCommandError("变更卡片流程版本", card_id, result.error),
            EXIT.usage,
          );
        persistEffect(tx, project, result.value);
      }
    });
    for (const card of cards) io.stdout(`卡片 ${card} 流程版本：${to}`);
    return EXIT.ok;
  } finally {
    store.close();
  }
}
