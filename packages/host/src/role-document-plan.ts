import {
  type Actor,
  type CardTemplate,
  type CommandPorts,
  type CommandState,
  createEmployee,
  createRole,
  type DomainError,
  type Employee,
  type EmployeeCommandPorts,
  type EmployeeId,
  employeeInProject,
  employeeNameKey,
  type Harness,
  manageCardTemplate,
  parseAvatarReference,
  type Result,
  type Role,
  type RoleDefinition,
  roleReference,
  roleUpgradeDiff,
  type TemplateWorkItem,
  updateRole,
} from "@cardigan/domain";
import {
  DEFAULT_ROLE_LAUNCH,
  defaultRoleDefinition,
  isDefaultRoleId,
  type RoleMarkdown,
} from "@cardigan/roles";
import { hashRequest } from "@cardigan/store";

export class RoleDocumentError extends Error {
  constructor(
    readonly code: DomainError["code"],
    message: string,
  ) {
    super(message);
  }
}
export function must<T>(r: Result<T>): T {
  if (!r.ok) throw new RoleDocumentError(r.error.code, r.error.message);
  return r.value;
}
function invalid(message: string): never {
  throw new RoleDocumentError("validation_failed", message);
}
export type Profiles = Readonly<Record<string, { readonly harness: Harness }>>;
/** Only new targets consult based_on. Include this resolved copy in the snapshot, even for a packaged source. */
export function roleSource(
  doc: RoleMarkdown,
  roles: ReadonlyMap<string, Role>,
  profiles: Profiles,
): RoleDefinition | undefined {
  const current = roles.get(doc.role_id);
  if (current || !doc.based_on) return current;
  const id = doc.based_on.replace(/^default:/u, "");
  const local = doc.based_on === id ? roles.get(id) : undefined;
  if (local || !isDefaultRoleId(id)) return local;
  const launch = DEFAULT_ROLE_LAUNCH[id];
  const ref = doc.launch_profile ?? launch?.launch_profile_ref ?? "";
  return defaultRoleDefinition(id, {
    launch_profile_ref: ref,
    harness: profile(profiles, ref)?.harness ?? launch?.harness ?? "codex",
  });
}
export function profile(profiles: Profiles, ref: string) {
  return Object.hasOwn(profiles, ref) ? profiles[ref] : undefined;
}
export function rolePlan(
  doc: RoleMarkdown,
  current: Role | undefined,
  base: RoleDefinition | undefined,
  profiles: Profiles,
  actor: Actor,
  project_id: string,
  preview: CommandPorts,
) {
  if (!base && doc.based_on) invalid(`基础角色 ${doc.based_on} 不存在`);
  const ref = doc.launch_profile ?? base?.launch_profile_ref;
  const launch = ref && profile(profiles, ref);
  if (!ref || !launch) invalid(`启动配置 ${ref ?? ""} 不存在于 launch.yaml`);
  const required = doc.required_capabilities ?? base?.required_capabilities;
  const tools = doc.tools;
  const allowed =
    tools && "set" in tools
      ? tools.set
      : [
          ...new Set([...(base?.allowed_tools ?? []), ...(tools?.add ?? [])]),
        ].filter((t) => !tools?.remove?.includes(t));
  const definition: RoleDefinition = {
    role_id: doc.role_id,
    display_name: doc.display_name ?? base?.display_name ?? doc.role_id,
    kind: doc.kind ?? base?.kind ?? "produce",
    core_prompt: doc.prompt_format
      ? doc.body
      : (doc.core_prompt ?? base?.core_prompt ?? ""),
    ...(doc.prompt_format ? {} : { instructions: doc.body }),
    launch_profile_ref: ref,
    harness: doc.harness ?? launch.harness,
    worktree: doc.worktree ?? base?.worktree ?? "none",
    allowed_tools: allowed,
    capabilities: doc.capabilities ?? base?.capabilities ?? [],
    abilities: doc.abilities ?? base?.abilities ?? [],
    required_machine_tags:
      doc.required_machine_tags ?? base?.required_machine_tags ?? [],
    ...(required && { required_capabilities: required }),
  };
  if (doc.prompt_format && current?.instructions !== undefined)
    invalid("已有角色使用 instructions，不能切换为旧提示格式");
  if (definition.harness !== launch.harness)
    invalid(`Harness 与启动配置 ${ref} 不一致`);
  if (
    doc.capabilities?.some(
      (c) =>
        !/^[a-z0-9][a-z0-9._-]*$/u.test(c) && !base?.capabilities.includes(c),
    )
  )
    invalid("能力编号不合法");
  const { role_id, ...patch } = definition;
  const state = { project_id, roles: current ? [current] : [] };
  const command = (ports: CommandPorts) =>
    must(
      current
        ? updateRole(state, actor, role_id, patch, ports)
        : createRole(state, actor, definition, ports),
    );
  const next = command(preview).data;
  const previous = current ?? {
    ...next,
    kind: "produce" as const,
    worktree: "none" as const,
    allowed_tools: [],
    capabilities: [],
    required_machine_tags: [],
    required_capabilities: [],
  };
  const keys = Object.keys(definition) as (keyof RoleDefinition)[];
  const normalize = (v: unknown) =>
    Array.isArray(v) ? [...new Set(v)].sort() : v;
  const same = (a: unknown, b: unknown) =>
    hashRequest(normalize(a)) === hashRequest(normalize(b));
  // Reimporting a legacy version is not a request to migrate its kind or derived tools.
  const exact = current && keys.every((k) => same(current[k], definition[k]));
  const fields = exact
    ? []
    : keys
        .filter((k) => !current || !same(current[k], next[k]))
        .map((field) => ({
          field,
          before: current?.[field] ?? null,
          after: next[field],
        }));
  const changed = fields.length > 0;
  const result = !current || changed ? next : current;
  const diff = roleUpgradeDiff(previous, {
    ...result,
    instructions: result.instructions ?? result.core_prompt,
  });
  return {
    command,
    changed,
    result,
    preview: {
      action: !current ? "create" : changed ? "update" : "unchanged",
      role: result,
      fields,
      relaxations: [
        ...(changed ? diff.relaxations : []),
        ...(
          ["required_machine_tags", "required_capabilities"] as const
        ).flatMap((k) =>
          (previous[k] ?? [])
            .filter((v) => !(result[k] ?? []).includes(v))
            .map((v) => `移除机器限制 ${v}`),
        ),
      ],
    },
  };
}

export function templatePlan(
  input: NonNullable<RoleMarkdown["template"]>,
  role: Role,
  source: CardTemplate | undefined,
  current: CardTemplate | undefined,
  state: CommandState,
  actor: Actor,
  preview: CommandPorts,
) {
  if (!source) invalid("找不到模板底稿，请指定 from");
  let items = [...source.work_items];
  let completion = source.completion;
  if (input.replace_role) {
    if (
      !items.some(
        (w) =>
          w.role_id === input.replace_role ||
          (!input.from && w.role_id === role.role_id),
      )
    )
      invalid(`模板没有角色 ${input.replace_role}`);
    items = items.map((w) =>
      w.role_id === input.replace_role ? { ...w, role_id: role.role_id } : w,
    );
    if (
      completion.mode === "review" &&
      completion.reviewer === `role:${input.replace_role}`
    )
      completion = { ...completion, reviewer: `role:${role.role_id}` };
  } else if (input.add_work_item) {
    const item = {
      ...input.add_work_item,
      role_id: role.role_id,
    } as TemplateWorkItem;
    const match = items.find((w) => w.key === item.key);
    if (!match || hashRequest(match) !== hashRequest(item)) items.push(item); // domain rejects conflicting keys
  }
  const definition = { ...source, id: input.id, work_items: items, completion };
  const command = (ports: CommandPorts) =>
    must(
      manageCardTemplate(
        { ...state, roles: [...state.roles, roleReference(role)] },
        actor,
        { action: current ? "update" : "add", definition },
        ports,
      ),
    );
  const next = command(preview).data;
  const changed =
    !current ||
    hashRequest({ ...next, version: current.version }) !== hashRequest(current);
  return {
    command,
    changed,
    preview: {
      action: !current ? "create" : changed ? "update" : "unchanged",
      before: current ?? null,
      after: !current || changed ? next : current,
    },
  };
}

export function employeePlans(
  projectId: string,
  doc: RoleMarkdown,
  role: Role,
  existing: readonly Employee[],
  profiles: Profiles,
  preview: CommandPorts,
) {
  const seen = new Set<string>();
  const employees = [...existing];
  return (doc.employees ?? []).map((entry, i) => {
    if (role.status === "inactive") invalid("员工角色已停用");
    if (
      entry.avatar !== undefined &&
      parseAvatarReference(entry.avatar)?.kind !== "library"
    )
      invalid("请选择有效的人物库头像");
    if (entry.launch_profile && !Object.hasOwn(profiles, entry.launch_profile))
      invalid(`启动配置 ${entry.launch_profile} 不存在于 launch.yaml`);
    const name = employeeNameKey(entry.name);
    if (seen.has(name)) invalid("文件内的员工姓名重复");
    seen.add(name);
    const current = employees.find(
      (e) => e.status === "active" && employeeNameKey(e.name) === name,
    );
    if (current && !employeeInProject(current, projectId))
      invalid(
        `在职员工 ${current.name} 不属于本项目 ${projectId}，不能通过导入更改归属`,
      );
    const input = {
      projects: [projectId],
      name: entry.name,
      title: entry.title,
      role_id: role.role_id,
      launch_profile_ref: entry.launch_profile ?? null,
      ...(entry.avatar !== undefined && { avatar: entry.avatar }),
      ...(entry.bio !== undefined && { bio: entry.bio }),
    };
    const others = employees.filter((e) => e !== current);
    const command = (ids: EmployeeCommandPorts["ids"]) =>
      must(
        createEmployee(others, { kind: "human" }, input, {
          ids,
          clock: preview.clock,
          launch_profiles: Object.keys(profiles),
        }),
      );
    const next = command({
      nextEmployeeId: () => `preview-${i}` as EmployeeId,
      nextEventId: preview.ids.nextEventId,
      nextEventSequence: () => 1,
    }).data;
    if (
      current &&
      (current.name !== next.name ||
        current.title !== next.title ||
        current.bio !== next.bio ||
        current.avatar !== next.avatar ||
        current.launch_profile_ref !== next.launch_profile_ref ||
        current.role_id !== next.role_id)
    )
      invalid(`在职员工 ${current.name} 的资料不同，不能覆盖`);
    if (!current) employees.push(next);
    return {
      command,
      changed: !current,
      preview: {
        name: next.name,
        title: next.title,
        bio: next.bio,
        avatar: next.avatar,
        role_id: next.role_id,
        launch_profile_ref: next.launch_profile_ref,
        action: current ? "unchanged" : "create",
        id: current?.id ?? null,
      },
    };
  });
}
