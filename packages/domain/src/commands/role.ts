import type { Actor, Event, ToolName } from "../entities.js";
import type { Result } from "../errors.js";
import { HOST_OPS_FORBIDDEN_TOOLS } from "../host-ops.js";
import type { ProjectId } from "../ids.js";
import {
  canManageRoles,
  isStandingOnlyTool,
  ROLE_TOOL_ALLOWLISTS,
  type Role,
  roleKind,
} from "../role.js";
import { roleInstructionsError } from "../role-prompt.js";
import { attempt, type CommandPorts, ensure, text } from "./core.js";

export interface RoleCommandState {
  readonly project_id: ProjectId;
  readonly roles: readonly Role[];
}
export type RoleDefinition = Omit<
  Role,
  "version" | "status" | "core_prompt"
> & {
  readonly core_prompt?: string;
};
export type RolePatch = Partial<Omit<RoleDefinition, "role_id">>;
export interface RoleEffect {
  readonly data: Role;
  readonly roles: readonly Role[];
  readonly events: readonly Event[];
}

const editable = [
  "display_name",
  "kind",
  "instructions",
  "core_prompt",
  "harness",
  "launch_profile_ref",
  "allowed_tools",
  "capabilities",
  "abilities",
  "worktree",
  "required_machine_tags",
];

function reviewTools(tools: readonly ToolName[]): readonly ToolName[] {
  return tools.includes("submit_review") && !tools.includes("withdraw_review")
    ? [...tools, "withdraw_review"]
    : tools;
}

/** Validate every write, including a copy or rollback of an older definition. */
export function validateRole(role: RoleDefinition): Result<RoleDefinition> {
  return attempt(() => {
    text(role.role_id, "role_id");
    ensure(
      /^[a-z0-9][a-z0-9._-]*$/u.test(role.role_id),
      "validation_failed",
      "角色编号不合法",
    );
    text(role.display_name, "display_name");
    ensure(
      ["work", "produce", "verify", "standing"].includes(role.kind),
      "validation_failed",
      "角色类型不合法",
    );
    ensure(
      ["claude-code", "codex", "pi"].includes(role.harness),
      "validation_failed",
      "Harness 不合法",
    );
    text(role.launch_profile_ref, "launch_profile_ref");
    if (role.instructions !== undefined) {
      ensure(
        typeof role.instructions === "string",
        "validation_failed",
        "instructions 必须是字符串",
      );
      const error = roleInstructionsError(role.instructions);
      ensure(
        error === undefined,
        "validation_failed",
        error ?? "instructions 不合法",
      );
    } else text(role.core_prompt, "core_prompt 或 instructions");
    ensure(
      role.core_prompt === undefined || typeof role.core_prompt === "string",
      "validation_failed",
      "core_prompt 必须是字符串",
    );
    for (const key of [
      "allowed_tools",
      "capabilities",
      "abilities",
      "required_machine_tags",
    ] as const) {
      ensure(
        Array.isArray(role[key]) &&
          role[key].every((value) => typeof value === "string" && value.trim()),
        "validation_failed",
        `${key} 必须是非空字符串数组`,
      );
    }
    // Save the derived permission in this new version; old roles/tokens stay fixed.
    role = { ...role, allowed_tools: reviewTools(role.allowed_tools) };
    const kind = roleKind(role);
    ensure(
      role.role_id === "host_ops" ||
        !role.allowed_tools.some((tool) => tool.startsWith("host_ops_")),
      "validation_failed",
      "host_ops_* 工具只能授予 host_ops 角色",
    );
    ensure(
      role.role_id !== "host_ops" ||
        (kind === "standing" &&
          !role.allowed_tools.some((tool) =>
            (HOST_OPS_FORBIDDEN_TOOLS as readonly string[]).includes(tool),
          )),
      "validation_failed",
      "host_ops 只能是常驻角色，不能派活、交付、审核、建卡或拍板",
    );
    const allowed = ROLE_TOOL_ALLOWLISTS[kind];
    ensure(
      role.allowed_tools.every((tool) => allowed.includes(tool)),
      "validation_failed",
      `${kind} 角色含有白名单之外的工具`,
    );
    ensure(
      !role.allowed_tools.some((t) =>
        [
          "record_decision",
          "resolve_delegated_decision",
          "triage_human_action",
          "replace_verification_work_item",
        ].includes(t),
      ) || role.role_id === "pm",
      "validation_failed",
      "record_decision 只能授予 pm 角色",
    );
    ensure(
      role.role_id === "pm" || !role.allowed_tools.some(isStandingOnlyTool),
      "validation_failed",
      "list_templates、list_roles 只能授予 pm 角色",
    );
    ensure(
      ["none", "readonly", "write"].includes(role.worktree),
      "validation_failed",
      "worktree 模式不合法",
    );
    ensure(
      kind !== "verify" || role.worktree !== "write",
      "validation_failed",
      "验证型角色的 worktree 只能为 readonly 或 none",
    );
    return { ...role, kind };
  });
}

function authorize(state: RoleCommandState, actor: Actor): void {
  ensure(
    canManageRoles(actor, state.project_id),
    "forbidden_tool",
    "只有同项目的人可以管理角色",
  );
}
function latest(state: RoleCommandState, id: string): Role | undefined {
  return state.roles
    .filter((role) => role.role_id === id)
    .sort((a, b) => b.version - a.version)[0];
}
function find(state: RoleCommandState, id: string, version?: number): Role {
  const role =
    version === undefined
      ? latest(state, id)
      : state.roles.find(
          (value) => value.role_id === id && value.version === version,
        );
  ensure(
    role,
    "not_found",
    `role ${id}${version === undefined ? "" : ` v${version}`} does not exist; use "role add" first`,
  );
  return role;
}
function save(
  state: RoleCommandState,
  actor: Actor,
  definition: RoleDefinition,
  status: "active" | "inactive",
  type: string,
  ports: CommandPorts,
): RoleEffect {
  const checked = validateRole(definition);
  ensure(
    checked.ok,
    "validation_failed",
    checked.ok ? "" : checked.error.message,
  );
  const source = checked.value;
  const role: Role = {
    role_id: source.role_id,
    display_name: source.display_name,
    kind: source.kind,
    core_prompt: source.core_prompt ?? "",
    ...(source.instructions === undefined
      ? {}
      : { instructions: source.instructions }),
    harness: source.harness,
    launch_profile_ref: source.launch_profile_ref,
    allowed_tools: [...source.allowed_tools],
    capabilities: [...source.capabilities],
    abilities: [...source.abilities],
    worktree: source.worktree,
    required_machine_tags: [...source.required_machine_tags],
    version: (latest(state, definition.role_id)?.version ?? 0) + 1,
    status,
  };
  return {
    data: role,
    roles: [role],
    events: [
      {
        id: ports.ids.nextEventId(),
        seq: ports.ids.nextEventSequence(state.project_id),
        type,
        actor,
        payload: { role: { ...role } },
        created_at: ports.clock.now(),
      },
    ],
  };
}

export function createRole(
  state: RoleCommandState,
  actor: Actor,
  input: RoleDefinition,
  ports: CommandPorts,
): Result<RoleEffect> {
  return attempt(() => {
    authorize(state, actor);
    ensure(
      !latest(state, input.role_id),
      "validation_failed",
      `role ${input.role_id} already exists; use "role update" to add a new version`,
    );
    ensure(
      Object.keys(input).every(
        (key) => key === "role_id" || editable.includes(key),
      ),
      "validation_failed",
      "角色版本和状态由命令管理",
    );
    return save(state, actor, input, "active", "role_created", ports);
  });
}

/** Source is a host-resolved default or project snapshot, read in the same transaction. */
export function copyRole(
  state: RoleCommandState,
  actor: Actor,
  input: {
    readonly source: RoleDefinition;
    readonly role_id: string;
    readonly display_name?: string;
  },
  ports: CommandPorts,
): Result<RoleEffect> {
  return attempt(() => {
    authorize(state, actor);
    ensure(
      !latest(state, input.role_id),
      "validation_failed",
      `role ${input.role_id} already exists; use "role update" to add a new version`,
    );
    return save(
      state,
      actor,
      {
        ...input.source,
        role_id: input.role_id,
        display_name: input.display_name ?? input.source.display_name,
      },
      "active",
      "role_copied",
      ports,
    );
  });
}

export function updateRole(
  state: RoleCommandState,
  actor: Actor,
  id: string,
  patch: RolePatch,
  ports: CommandPorts,
): Result<RoleEffect> {
  return attempt(() => {
    authorize(state, actor);
    const previous = find(state, id);
    ensure(
      Object.keys(patch).length > 0 &&
        Object.keys(patch).every((key) => editable.includes(key)),
      "validation_failed",
      "只允许修改角色可编辑字段",
    );
    return save(
      state,
      actor,
      { ...previous, ...patch },
      previous.status ?? "active",
      "role_updated",
      ports,
    );
  });
}

function changeStatus(
  state: RoleCommandState,
  actor: Actor,
  id: string,
  status: "active" | "inactive",
  ports: CommandPorts,
): Result<RoleEffect> {
  return attempt(() => {
    authorize(state, actor);
    const previous = find(state, id);
    if ((previous.status ?? "active") === status)
      return { data: previous, roles: [], events: [] };
    return save(
      state,
      actor,
      previous,
      status,
      status === "active" ? "role_activated" : "role_deactivated",
      ports,
    );
  });
}
export function deactivateRole(
  state: RoleCommandState,
  actor: Actor,
  id: string,
  ports: CommandPorts,
): Result<RoleEffect> {
  return changeStatus(state, actor, id, "inactive", ports);
}
export function activateRole(
  state: RoleCommandState,
  actor: Actor,
  id: string,
  ports: CommandPorts,
): Result<RoleEffect> {
  return changeStatus(state, actor, id, "active", ports);
}
export function rollbackRole(
  state: RoleCommandState,
  actor: Actor,
  id: string,
  version: number,
  ports: CommandPorts,
): Result<RoleEffect> {
  return attempt(() => {
    authorize(state, actor);
    const previous = find(state, id);
    const source = find(state, id, version);
    return save(
      state,
      actor,
      source,
      previous.status ?? "active",
      "role_rolled_back",
      ports,
    );
  });
}

/** The fields a role takes from the default pack on `role upgrade --from-default`. */
export const DEFAULT_PACK_FIELDS = [
  "instructions",
  "allowed_tools",
  "capabilities",
  "kind",
  "worktree",
] as const;
export type DefaultPackPatch = Pick<
  RoleDefinition,
  "allowed_tools" | "capabilities" | "kind" | "worktree"
> & { readonly instructions: string };

export interface RoleFieldChange {
  readonly field: "instructions" | "kind" | "worktree";
  readonly from: string;
  readonly to: string;
}
export interface RoleUpgradeDiff {
  readonly added_tools: readonly string[];
  readonly removed_tools: readonly string[];
  readonly added_capabilities: readonly string[];
  readonly removed_capabilities: readonly string[];
  readonly fields: readonly RoleFieldChange[];
  /** Human-readable widenings; the CLI lists them prominently. */
  readonly relaxations: readonly string[];
}
export type RoleUpgradeEffect =
  | {
      readonly unchanged: true;
      readonly previous: Role;
      readonly diff: RoleUpgradeDiff;
    }
  | {
      readonly unchanged: false;
      readonly previous: Role;
      readonly diff: RoleUpgradeDiff;
      readonly effect: RoleEffect;
    };

const WORKTREE_RANK = { none: 0, readonly: 1, write: 2 } as const;
const KIND_LABEL: Record<string, string> = {
  produce: "产出",
  verify: "验证",
  standing: "常驻",
  work: "旧版工作",
};

/** Pure diff between a role version and the default-pack fields it would take. */
export function roleUpgradeDiff(
  previous: Role,
  patch: DefaultPackPatch,
): RoleUpgradeDiff {
  const minus = (a: readonly string[], b: readonly string[]) =>
    a.filter((value) => !b.includes(value));
  const added_tools = minus(patch.allowed_tools, previous.allowed_tools);
  const removed_tools = minus(previous.allowed_tools, patch.allowed_tools);
  const added_capabilities = minus(patch.capabilities, previous.capabilities);
  const removed_capabilities = minus(previous.capabilities, patch.capabilities);
  const fields: RoleFieldChange[] = [];
  const previousKind = roleKind(previous);
  if (previous.kind !== patch.kind)
    fields.push({ field: "kind", from: previous.kind, to: patch.kind });
  if (previous.worktree !== patch.worktree)
    fields.push({
      field: "worktree",
      from: previous.worktree,
      to: patch.worktree,
    });
  if ((previous.instructions ?? previous.core_prompt) !== patch.instructions)
    fields.push({
      field: "instructions",
      from:
        previous.instructions === undefined
          ? "core_prompt（旧版）"
          : "旧版说明",
      to: "默认包说明",
    });
  const relaxations = [
    ...added_tools.map((tool) => `新增工具 ${tool}`),
    ...added_capabilities.map((value) => `新增能力 ${value}`),
    ...(WORKTREE_RANK[patch.worktree] > WORKTREE_RANK[previous.worktree]
      ? [`worktree 从 ${previous.worktree} 放宽为 ${patch.worktree}`]
      : []),
    ...(previousKind !== roleKind(patch)
      ? [
          `角色类型从${KIND_LABEL[previousKind]}改为${KIND_LABEL[roleKind(patch)]}，工具白名单随之改变`,
        ]
      : []),
  ];
  return {
    added_tools,
    removed_tools,
    added_capabilities,
    removed_capabilities,
    fields,
    relaxations,
  };
}

export interface RoleUpgradePreview {
  readonly unchanged: boolean;
  readonly previous: Role;
  readonly diff: RoleUpgradeDiff;
  readonly patch: DefaultPackPatch;
}

/**
 * Compute what `upgradeRole` would write, without allocating ids or events, so
 * a dry run can use a read-only transaction. A changed definition is checked
 * with the same `validateRole` the write uses.
 */
export function previewRoleUpgrade(
  state: RoleCommandState,
  actor: Actor,
  id: string,
  source: RoleDefinition,
): Result<RoleUpgradePreview> {
  return attempt(() => {
    authorize(state, actor);
    ensure(
      source.role_id === id && source.instructions !== undefined,
      "validation_failed",
      `默认角色包里的 ${id} 不完整`,
    );
    const previous = find(state, id);
    const patch: DefaultPackPatch = {
      instructions: source.instructions,
      allowed_tools: [...reviewTools(source.allowed_tools)],
      capabilities: [...source.capabilities],
      kind: source.kind,
      worktree: source.worktree,
    };
    const diff = roleUpgradeDiff(previous, patch);
    const same = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && a.every((value) => b.includes(value));
    const unchanged =
      diff.fields.length === 0 &&
      same(previous.allowed_tools, patch.allowed_tools) &&
      same(previous.capabilities, patch.capabilities);
    if (!unchanged) {
      const checked = validateRole({ ...previous, ...patch });
      ensure(
        checked.ok,
        "validation_failed",
        checked.ok ? "" : checked.error.message,
      );
    }
    return { unchanged, previous, diff, patch };
  });
}

/**
 * Append a version whose policy fields come from the default pack, keeping the
 * project's own launch fields. The caller resolves `source` from the pack; the
 * write itself is `updateRole`, so authorization and `validateRole` are shared.
 */
export function upgradeRole(
  state: RoleCommandState,
  actor: Actor,
  id: string,
  source: RoleDefinition,
  ports: CommandPorts,
): Result<RoleUpgradeEffect> {
  return attempt(() => {
    const preview = previewRoleUpgrade(state, actor, id, source);
    ensure(
      preview.ok,
      preview.ok ? "validation_failed" : preview.error.code,
      preview.ok ? "" : preview.error.message,
    );
    const { unchanged, previous, diff, patch } = preview.value;
    if (unchanged) return { unchanged: true, previous, diff };
    const effect = updateRole(state, actor, id, patch, ports);
    ensure(
      effect.ok,
      effect.ok ? "validation_failed" : effect.error.code,
      effect.ok ? "" : effect.error.message,
    );
    return { unchanged: false, previous, diff, effect: effect.value };
  });
}
