import {
  type Employee,
  type EmployeeActor,
  type EmployeeCommandPorts,
  type EmployeeEffect,
  employeeDisplayName,
  employeeNameKey,
  employeeTextError,
} from "../employee.js";
import type { Result } from "../errors.js";
import { type EmployeeId, parseId } from "../ids.js";
import { transition } from "../transitions.js";
import { attempt, ensure, unwrap } from "./core.js";

export interface CreateEmployeeInput {
  readonly name: string;
  readonly title: string;
  readonly role_id: string;
  readonly projects?: Employee["projects"];
  readonly bio?: string;
  readonly avatar?: string | null;
  readonly launch_profile_ref?: string | null;
}
export type UpdateEmployeeInput = Partial<
  Pick<
    Employee,
    "name" | "title" | "bio" | "avatar" | "launch_profile_ref" | "projects"
  >
>;

function human(actor: EmployeeActor): void {
  ensure(actor.kind === "human", "forbidden_tool", "只有人可以管理员工");
}

function field(
  value: unknown,
  label: string,
  limit?: number,
  required = false,
): asserts value is string {
  const error = employeeTextError(value, label, limit, required);
  ensure(error === undefined, "validation_failed", error ?? "员工字段不合法");
}

function validate(
  employee: Omit<Employee, "id"> & { readonly id?: EmployeeId },
  others: readonly Employee[],
  ports: EmployeeCommandPorts,
  checkProfile: boolean,
): void {
  if (employee.projects !== undefined) {
    ensure(
      Array.isArray(employee.projects),
      "validation_failed",
      "所属项目必须是列表",
    );
    for (const id of employee.projects) {
      field(id, "项目编号", undefined, true);
      ensure(id === id.trim(), "validation_failed", "项目编号不能含首尾空格");
    }
    ensure(
      new Set(employee.projects).size === employee.projects.length,
      "validation_failed",
      "所属项目不能重复",
    );
  }
  field(employee.name, "名字", 40, true);
  field(employee.title, "职位", 40, true);
  field(employee.bio, "简介", 200);
  field(employee.role_id, "角色", undefined, true);
  ensure(
    /^[a-z0-9][a-z0-9._-]*$/u.test(employee.role_id),
    "validation_failed",
    "角色编号不合法",
  );
  if (employee.avatar !== null)
    field(employee.avatar, "头像引用", undefined, true);
  if (employee.avatar?.startsWith("library:")) {
    const occupant = others.find(
      (other) => other.id !== employee.id && other.avatar === employee.avatar,
    );
    ensure(
      !occupant,
      "validation_failed",
      `人物已被员工 ${occupant?.name}（${occupant?.id}）使用，在职和离职员工均占用人物`,
    );
  }
  if (employee.launch_profile_ref !== null) {
    field(employee.launch_profile_ref, "启动配置", undefined, true);
    ensure(
      !checkProfile ||
        ports.launch_profiles?.includes(employee.launch_profile_ref),
      "validation_failed",
      `启动配置 ${employee.launch_profile_ref} 不存在于 launch.yaml`,
    );
  }
  ensure(
    employee.status !== "active" ||
      !others.some(
        (other) =>
          other.id !== employee.id &&
          other.status === "active" &&
          employeeNameKey(other.name) === employeeNameKey(employee.name),
      ),
    "validation_failed",
    `在职员工已使用名字：${employee.name}`,
  );
}

function effect(
  employee: Employee,
  type: string,
  ports: EmployeeCommandPorts,
): EmployeeEffect {
  return {
    data: employee,
    employees: [employee],
    events: [
      {
        id: ports.ids.nextEventId(),
        seq: ports.ids.nextEventSequence(),
        type,
        actor: { kind: "human" },
        payload: { employee: { ...employee } },
        created_at: employee.updated_at,
      },
    ],
  };
}

function find(employees: readonly Employee[], id: EmployeeId): Employee {
  ensure(
    parseId("employee", id).ok,
    "validation_failed",
    "员工编号必须为 E-n（正整数）",
  );
  const employee = employees.find((value) => value.id === id);
  ensure(employee, "not_found", `员工 ${id} 不存在`);
  return employee;
}

export function createEmployee(
  employees: readonly Employee[],
  actor: EmployeeActor,
  input: CreateEmployeeInput,
  ports: EmployeeCommandPorts,
): Result<EmployeeEffect> {
  return attempt(() => {
    human(actor);
    const now = ports.clock.now();
    // Validate before allocating: a rejected command must not consume an ID.
    const employee: Omit<Employee, "id"> = {
      name: input.name,
      projects: input.projects === undefined ? [] : input.projects,
      title: input.title,
      role_id: input.role_id,
      bio: input.bio ?? "",
      avatar: input.avatar ?? null,
      launch_profile_ref: input.launch_profile_ref ?? null,
      status: "active",
      created_at: now,
      updated_at: now,
    };
    validate(employee, employees, ports, true);
    return effect(
      {
        ...employee,
        id: ports.ids.nextEmployeeId(),
        name: employeeDisplayName(employee.name),
        title: employee.title.trim(),
        bio: employee.bio.trim(),
      },
      "employee_created",
      ports,
    );
  });
}

export function updateEmployee(
  employees: readonly Employee[],
  actor: EmployeeActor,
  id: EmployeeId,
  input: UpdateEmployeeInput,
  ports: EmployeeCommandPorts,
): Result<EmployeeEffect> {
  return attempt(() => {
    human(actor);
    const previous = find(employees, id);
    const keys = Object.keys(input);
    ensure(keys.length > 0, "validation_failed", "至少指定一个员工修改字段");
    ensure(
      keys.every((key) =>
        [
          "name",
          "title",
          "bio",
          "avatar",
          "launch_profile_ref",
          "projects",
        ].includes(key),
      ),
      "validation_failed",
      "不支持修改员工编号、角色、状态或审计字段",
    );
    const employee = { ...previous, ...input, updated_at: ports.clock.now() };
    validate(
      employee,
      employees,
      ports,
      Object.hasOwn(input, "launch_profile_ref"),
    );
    return effect(
      {
        ...employee,
        name: employeeDisplayName(employee.name),
        title: employee.title.trim(),
        bio: employee.bio.trim(),
      },
      "employee_updated",
      ports,
    );
  });
}

function changeStatus(
  employees: readonly Employee[],
  actor: EmployeeActor,
  id: EmployeeId,
  action: "activate" | "deactivate",
  ports: EmployeeCommandPorts,
): Result<EmployeeEffect> {
  return attempt(() => {
    human(actor);
    const previous = find(employees, id);
    if (previous.status === (action === "activate" ? "active" : "inactive")) {
      return { data: previous, employees: [], events: [] };
    }
    const employee = {
      ...previous,
      status: unwrap(transition("employee", previous.status, action)),
      updated_at: ports.clock.now(),
    };
    validate(employee, employees, ports, false);
    return effect(
      employee,
      action === "activate" ? "employee_activated" : "employee_deactivated",
      ports,
    );
  });
}

export function activateEmployee(
  employees: readonly Employee[],
  actor: EmployeeActor,
  id: EmployeeId,
  ports: EmployeeCommandPorts,
): Result<EmployeeEffect> {
  return changeStatus(employees, actor, id, "activate", ports);
}
export function deactivateEmployee(
  employees: readonly Employee[],
  actor: EmployeeActor,
  id: EmployeeId,
  ports: EmployeeCommandPorts,
): Result<EmployeeEffect> {
  return changeStatus(employees, actor, id, "deactivate", ports);
}
