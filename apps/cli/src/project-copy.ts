import {
  type Actor,
  copyRole,
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
 * Roles the target already has are kept; preferences take the source values,
 * except the human's authorizations and gates, which stay at the new
 * project's defaults until the human sets them (PM decision, C-794#8).
 */

const USAGE =
  "用法：cardigan project copy-setup --from <源项目> [--project <目标项目>] [--data-dir <目录>]";
/**
 * Never copied: category authorizations, automatic and PM-confirmed merges,
 * delegated review raises and the path gates (with the flow version, which
 * from 4 requires the release paths). Key → `cardigan preference` name.
 */
export const GATE_PREFERENCES = {
  flow_version: "flow-version",
  decision_delegation: "decision-delegation",
  auto_merge: "auto-merge",
  auto_merge_after_minutes: "auto-merge-after",
  auto_merge_paused: "auto-merge-paused",
  pm_merge_confirmation: "pm-merge-confirmation",
  pm_confirm_role_rule_implementations: "pm-confirm-role-rule-implementations",
  pm_confirm_human_decided_merges: "pm-confirm-human-decided-merges",
  enable_reviewer_browser: "reviewer-browser",
  independent_review_limit_delegation: "independent-review-limit-delegation",
  independent_review_limit_delegation_max:
    "independent-review-limit-delegation-max",
  system_review_limit_raise: "system-review-limit-raise",
  system_review_limit_max_raises: "system-review-limit-max-raises",
  high_risk_paths: "high-risk-paths",
  auto_security_paths: "auto-security-paths",
  role_rule_paths: "role-rule-paths",
  system_merge_shadow_policy: "system-merge-shadow-policy",
  // Set in Workbench settings only; PM's direct messages to the owner.
  pm_owner_messages: "pm-owner-messages",
} as const satisfies Partial<Record<keyof ProjectPreferences, string>>;
/**
 * Every preference, classified. The mapped type makes a preference added
 * later fail to compile until it is classified here, so nothing new is
 * copied by default. `templates` is copied as switches.
 */
const PREFERENCE_COPY: {
  readonly [K in keyof Required<ProjectPreferences>]: K extends keyof typeof GATE_PREFERENCES
    ? "gate"
    : "copy" | "view" | "templates";
} = {
  id: "view",
  board_collapsed_lanes: "view",
  human_card_templates: "templates",
  machine_preference: "copy",
  cross_card_read: "copy",
  shared_files_access: "copy",
  system_merge_shadow: "copy",
  system_auto_assign_verifiers: "copy",
  system_reminders: "copy",
  pm_owner_messages: "gate",
  system_reminder_policy: "copy",
  context_handoff_remaining_pct: "copy",
  context_restart_remaining_pct: "copy",
  merge_confirm_stall_after_minutes: "copy",
  merge_confirm_snooze_default_minutes: "copy",
  merge_confirm_snooze_max_minutes: "copy",
  review_max_rounds: "copy",
  independent_review_max_rounds: "copy",
  tick_profile: "copy",
  flow_version: "gate",
  decision_delegation: "gate",
  auto_merge: "gate",
  auto_merge_after_minutes: "gate",
  auto_merge_paused: "gate",
  pm_merge_confirmation: "gate",
  pm_confirm_role_rule_implementations: "gate",
  pm_confirm_human_decided_merges: "gate",
  enable_reviewer_browser: "gate",
  independent_review_limit_delegation: "gate",
  independent_review_limit_delegation_max: "gate",
  system_review_limit_raise: "gate",
  system_review_limit_max_raises: "gate",
  high_risk_paths: "gate",
  auto_security_paths: "gate",
  role_rule_paths: "gate",
  system_merge_shadow_policy: "gate",
};
const COPIED_KEYS: readonly string[] = Object.entries(PREFERENCE_COPY)
  .filter(([, how]) => how === "copy")
  .map(([key]) => key);

export interface ProjectSetupCopy {
  readonly copied_roles: readonly string[];
  /** Already present in the target; left unchanged. */
  readonly kept_roles: readonly string[];
  /** Target preferences the source does not set; left unchanged. */
  readonly kept_preferences: readonly string[];
  /** Target preferences already set that took a different source value. */
  readonly overwritten_preferences: readonly string[];
  /** Gate preferences the source sets, as `cardigan preference` names. */
  readonly not_copied: readonly string[];
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
    "  项目偏好：除授权和门禁类外已按源项目设置",
    ...(result.kept_preferences.length
      ? [`  源项目未设、保留目标项目值的偏好：${list(result.kept_preferences)}`]
      : []),
    ...(result.overwritten_preferences.length
      ? [
          `  目标项目原有值被源项目覆盖的偏好：${list(result.overwritten_preferences)}`,
        ]
      : []),
    ...(result.not_copied.length
      ? [
          `  授权和门禁类不复制，保持本项目原值，需要时由人设置：${list(result.not_copied)}`,
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
    const after: ProjectPreferences = result.value.data;
    const value = (p: ProjectPreferences, key: string) =>
      JSON.stringify(p[key as keyof ProjectPreferences] ?? null);
    return {
      copied_roles: copied.map((role) => role.role_id),
      kept_roles: sources
        .filter((role) => existing.has(role.role_id))
        .map((role) => role.role_id),
      kept_preferences: Object.keys(before).filter(
        (key) =>
          COPIED_KEYS.includes(key) &&
          before[key as keyof ProjectPreferences] !== undefined &&
          !Object.hasOwn(patch, key),
      ),
      overwritten_preferences: COPIED_KEYS.filter(
        (key) =>
          before[key as keyof ProjectPreferences] !== undefined &&
          value(before, key) !== value(after, key),
      ),
      not_copied: Object.entries(GATE_PREFERENCES)
        .filter(
          ([key]) => (source[key as keyof ProjectPreferences] ?? null) !== null,
        )
        .map(([, name]) => name),
    };
  });
}

/** The source's settings as one `setProjectPreferences` patch. */
function preferencePatch(
  source: ProjectPreferences,
  target: ProjectPreferences,
): Parameters<typeof setProjectPreferences>[2] {
  const rest = Object.fromEntries(
    Object.entries(source).filter(([key]) => COPIED_KEYS.includes(key)),
  ) as Parameters<typeof setProjectPreferences>[2];
  // Templates are a patch of switches: close what the source does not open.
  const open = humanCardTemplates(source);
  const templates = Object.fromEntries([
    ...humanCardTemplates(target)
      .filter((template) => !open.includes(template))
      .map((template) => [template, false]),
    ...open.map((template) => [template, true]),
  ]);
  return { ...rest, human_card_templates: templates };
}

/** The preferences a copy carries over, in a comparable form. */
export function comparablePreferences(preferences: ProjectPreferences): string {
  // Templates are stored as a patch over the default; compare the effect.
  const normalized: Record<string, unknown> = {
    ...preferences,
    human_card_templates: [...humanCardTemplates(preferences)].sort(),
  };
  const entries = Object.entries(normalized)
    .filter(
      ([key, value]) =>
        (COPIED_KEYS.includes(key) || key === "human_card_templates") &&
        value !== undefined,
    )
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}
