import {
  type Actor,
  copyRole,
  decisionDelegation,
  humanCardTemplates,
  type ProjectId,
  type ProjectPreferences,
  projectPreferences,
  setProjectPreferences,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import {
  listRoleVersions,
  openStore,
  persistRoleEffect,
  type Store,
} from "@cardigan/store";
import { validProfileNames } from "./config.js";
import { CliError, EXIT, formatCommandError } from "./errors.js";
import {
  announceDataDir,
  loadProjectMergeGate,
  resolveActor,
  resolveProject,
  systemClock,
} from "./host.js";
import type { CliIo } from "./io.js";
import { cliLaunchPaths } from "./paths.js";

/**
 * C-794: copy every active role and the project preferences of an existing
 * project into another one, in one transaction (onboarding steps 4 and 6).
 * Roles the target already has are kept; preferences take the source values.
 */

const USAGE =
  "用法：cardigan project copy-setup --from <源项目> [--project <目标项目>] [--data-dir <目录>]";
/** Preferences that name paths of the source repository. */
const REPOSITORY_PATH_PREFERENCES = [
  "high_risk_paths",
  "auto_security_paths",
  "role_rule_paths",
  "system_merge_shadow_policy",
] as const;
/** A per-device board view setting, not a project rule. */
const VIEW_PREFERENCES = ["id", "board_collapsed_lanes"];

export interface ProjectSetupCopy {
  readonly copied_roles: readonly string[];
  /** Already present in the target; left unchanged. */
  readonly kept_roles: readonly string[];
  /** Target preferences the source does not set; left unchanged. */
  readonly kept_preferences: readonly string[];
  /** Copied preferences that name paths of the source repository. */
  readonly path_preferences: readonly string[];
}

export async function runProjectCopySetup(
  args: readonly string[],
  io: CliIo,
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i]?.startsWith("--") ? args[i]?.slice(2) : undefined;
    const value = args[i + 1];
    if (
      name === undefined ||
      !["from", "project", "data-dir"].includes(name) ||
      flags[name] !== undefined ||
      value === undefined ||
      value.startsWith("--")
    )
      throw new CliError(`不认识的参数：${args[i]}`, EXIT.usage, [USAGE]);
    flags[name] = value;
  }
  if (flags.from === undefined)
    throw new CliError("需要 --from <源项目>", EXIT.usage, [USAGE]);
  const store = openStore({ dataDir: announceDataDir(io, flags["data-dir"]) });
  try {
    const target = resolveProject(store, io, flags.project);
    const result = await copyProjectSetup(store, io, {
      from: flags.from,
      to: target,
      ...(flags["data-dir"] ? { dataDir: flags["data-dir"] } : {}),
    });
    io.stdout(formatProjectSetupCopy(flags.from, target, result));
    return EXIT.ok;
  } finally {
    store.close();
  }
}

export function formatProjectSetupCopy(
  from: string,
  to: string,
  result: ProjectSetupCopy,
): string {
  const list = (values: readonly string[]) =>
    values.length ? values.join("、") : "无";
  return [
    `已从项目 ${from} 复制到 ${to}：`,
    `  角色 ${result.copied_roles.length} 个：${list(result.copied_roles)}`,
    ...(result.kept_roles.length
      ? [`  目标项目已有、未覆盖的角色：${list(result.kept_roles)}`]
      : []),
    "  项目偏好：已按源项目设置",
    ...(result.kept_preferences.length
      ? [`  源项目未设、保留目标项目值的偏好：${list(result.kept_preferences)}`]
      : []),
    ...(result.path_preferences.length
      ? [
          `  以下偏好写的是源仓库的路径，请按新仓库核对：${list(result.path_preferences)}`,
        ]
      : []),
  ].join("\n");
}

export async function copyProjectSetup(
  store: Store,
  io: CliIo,
  input: { readonly from: string; readonly to: ProjectId; dataDir?: string },
): Promise<ProjectSetupCopy> {
  const { from, to } = input;
  if (!store.getProject(from))
    throw new CliError(`来源项目 ${from} 不存在`, EXIT.usage);
  if (from === to) throw new CliError("来源项目和目标项目相同", EXIT.usage);
  const actor: Actor = resolveActor(io, to, store);
  const gate = await loadProjectMergeGate(store, to, io, input.dataDir);
  const profiles = (() => {
    try {
      return validProfileNames(cliLaunchPaths(io, input.dataDir));
    } catch {
      return undefined;
    }
  })();
  return store.uow.run((tx) => {
    const latest = (project: string) => [
      ...new Map(
        listRoleVersions(tx, project).map((role) => [role.role_id, role]),
      ).values(),
    ];
    const existing = new Set(latest(to).map((role) => role.role_id));
    const sources = latest(from).filter((role) => role.status !== "inactive");
    const copied = sources.filter((role) => !existing.has(role.role_id));
    if (copied.length && profiles === undefined)
      throw new CliError(
        "读不了 launch.yaml，无法核对角色的启动配置，未复制任何内容",
        EXIT.usage,
      );
    // Same rule as `role copy`: every copied role must start on this host.
    const unknown = copied.filter(
      (role) => !profiles?.has(role.launch_profile_ref),
    );
    if (unknown.length)
      throw new CliError(
        `launch.yaml 没有这些角色引用的启动配置，未复制任何内容：${unknown.map((role) => `${role.role_id}→${role.launch_profile_ref}`).join("、")}`,
        EXIT.usage,
      );
    const ports = { clock: systemClock, ids: tx.ids };
    for (const source of copied) {
      const result = copyRole(
        { project_id: to, roles: listRoleVersions(tx, to) },
        actor,
        { source, role_id: source.role_id },
        ports,
      );
      if (!result.ok)
        throw new CliError(
          formatCommandError("复制角色", source.role_id, result.error),
          EXIT.usage,
        );
      persistRoleEffect(tx, to, result.value);
    }

    const source = tx.project_preferences.get(from, from) ?? {
      id: from,
      auto_merge_after_minutes: null,
    };
    const state = loadCommandState(tx, to);
    const before = projectPreferences(state);
    const patch = preferencePatch(source, before);
    const result = setProjectPreferences(
      {
        ...state,
        project_settings: {
          ...state.project_settings,
          merge_gate_enabled: gate.status !== "disabled",
        },
      },
      actor,
      patch,
      ports,
    );
    if (!result.ok)
      throw new CliError(
        formatCommandError("复制项目偏好", to, result.error),
        EXIT.usage,
      );
    persistEffect(tx, to, result.value);
    return {
      copied_roles: copied.map((role) => role.role_id),
      kept_roles: sources
        .filter((role) => existing.has(role.role_id))
        .map((role) => role.role_id),
      kept_preferences: Object.keys(before).filter(
        (key) =>
          !VIEW_PREFERENCES.includes(key) &&
          before[key as keyof ProjectPreferences] !== undefined &&
          !Object.hasOwn(patch, key),
      ),
      path_preferences: REPOSITORY_PATH_PREFERENCES.filter(
        (key) => source[key] !== undefined && source[key] !== null,
      ),
    };
  });
}

/** The source's settings as one `setProjectPreferences` patch. */
function preferencePatch(
  source: ProjectPreferences,
  target: ProjectPreferences,
): Parameters<typeof setProjectPreferences>[2] {
  const {
    id: _id,
    board_collapsed_lanes: _lanes,
    human_card_templates: _templates,
    ...rest
  } = source;
  // Templates are a patch of switches: close what the source does not open.
  const open = humanCardTemplates(source);
  const templates = Object.fromEntries([
    ...humanCardTemplates(target)
      .filter((template) => !open.includes(template))
      .map((template) => [template, false]),
    ...open.map((template) => [template, true]),
  ]);
  return {
    ...rest,
    auto_merge_after_minutes: source.auto_merge_after_minutes ?? null,
    human_card_templates: templates,
  };
}

/** Preferences as compared after a copy: without id and view settings. */
export function comparablePreferences(preferences: ProjectPreferences): string {
  // Both are stored as patches over defaults; compare their effective values.
  const normalized: Record<string, unknown> = {
    ...preferences,
    decision_delegation: decisionDelegation(preferences),
    human_card_templates: [...humanCardTemplates(preferences)].sort(),
  };
  const entries = Object.entries(normalized)
    .filter(
      ([key, value]) => !VIEW_PREFERENCES.includes(key) && value !== undefined,
    )
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}
