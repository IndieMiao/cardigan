import type { Actor, Event } from "../entities.js";
import type { Result } from "../errors.js";
import type { ProjectId } from "../ids.js";
import {
  canManageRoles,
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
    const kind = roleKind(role);
    const allowed = ROLE_TOOL_ALLOWLISTS[kind];
    ensure(
      role.allowed_tools.every((tool) => allowed.includes(tool)),
      "validation_failed",
      `${kind} 角色含有白名单之外的工具`,
    );
    ensure(
      !role.allowed_tools.includes("record_decision") || role.role_id === "pm",
      "validation_failed",
      "record_decision 只能授予 pm 角色",
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
