import {
  type Employee,
  employeeInProject,
  employeeNameKey,
} from "../employee.js";
import type { Delivery, WorkItem } from "../entities.js";
import type { EmployeeId } from "../ids.js";
import { isCompletionVerifier } from "../templates.js";
import {
  attempt,
  type CommandDraft,
  type CommandState,
  ensure,
} from "./core.js";
import { resolveCardTemplate } from "./templates.js";

/** Resolve an explicit ID, or an active display name, without accepting identity claims. */
export function resolveEmployee(d: CommandDraft, reference: string): Employee {
  return findEmployee(d.state.employees ?? [], reference);
}

function findEmployee(
  employees: readonly Employee[],
  reference: string,
): Employee {
  const employee =
    employees.find((e) => e.id === reference) ??
    employees.find(
      (e) =>
        e.status === "active" &&
        employeeNameKey(e.name) === employeeNameKey(reference),
    );
  ensure(employee, "not_found", `员工 ${reference} 不存在或名字不属于在职员工`);
  return employee;
}

export function checkEmployeeProject(employee: Employee, projectId: string) {
  ensure(
    employeeInProject(employee, projectId),
    "validation_failed",
    `员工 ${employee.id} 不属于本项目 ${projectId}`,
  );
}

export function noProjectEmployee(roleId: string) {
  return `本项目没有可用员工（角色 ${roleId}）`;
}

// Old snapshots omitted projects; an explicit [] is a current all-project employee.
function hasScopedRoster(employees: readonly Employee[]) {
  return employees.some((e) => e.projects !== undefined);
}

function allowLegacyUnnamed(employees: readonly Employee[], roleId: string) {
  ensure(
    !hasScopedRoster(employees),
    "invariant_violation",
    noProjectEmployee(roleId),
  );
}

type StaffingState = Pick<
  CommandState,
  "project_id" | "employees" | "assignments" | "employee_activity"
>;

export function selectStandingEmployee(
  state: StaffingState,
  roleId: "pm" | "host_ops",
  reference?: string,
  destination: "internal" | "external" = "internal",
) {
  return attempt(() => {
    const employees = state.employees ?? [];
    const eligible = (e: Employee) =>
      destination === "external" || !isExternalEmployee(state, e.id);
    if (reference !== undefined) {
      const employee = findEmployee(employees, reference);
      checkEmployeeProject(employee, state.project_id);
      ensure(
        employee.status === "active" && employee.role_id === roleId,
        "validation_failed",
        `员工须为在职的 ${roleId} 角色`,
      );
      ensure(
        eligible(employee),
        "invariant_violation",
        "这是外接员工，不能指派给内部常驻身份",
      );
      return employee;
    }
    const active = employees.filter(
      (e) =>
        employeeInProject(e, state.project_id) &&
        e.status === "active" &&
        e.role_id === roleId,
    );
    const candidates = active.filter(eligible);
    ensure(
      !active.length || candidates.length,
      "invariant_violation",
      `${noProjectEmployee(roleId)}：该角色的在职员工均为外接员工`,
    );
    // Unnamed PM bootstrap predates employee membership.
    if (roleId === "pm" && !hasScopedRoster(employees)) return;
    ensure(
      candidates.length <= 1,
      "validation_failed",
      `有多个在职${roleId === "pm" ? " PM " : "主机运维"}员工，请用 --employee 指定`,
    );
    if (!candidates.length) allowLegacyUnnamed(employees, roleId);
    return candidates[0];
  });
}

function isExternalEmployee(
  state: StaffingState,
  employee_id: EmployeeId,
): boolean {
  return (
    state.employee_activity?.some(
      (activity) =>
        activity.employee_id === employee_id &&
        activity.has_external_standing_assignment,
    ) === true ||
    state.assignments.some(
      (assignment) =>
        assignment.employee_id === employee_id &&
        assignment.scope === "standing" &&
        assignment.external === true &&
        assignment.status !== "released",
    )
  );
}

export function checkEmployeeNotExternal(
  d: CommandDraft,
  employee_id?: EmployeeId,
): void {
  ensure(
    !employee_id || !isExternalEmployee(d.state, employee_id),
    "invariant_violation",
    "这是外接员工，不由 Cardigan 启动，不能指派工作项",
  );
}

/** General work-item candidates; author/reviewer separation is checked per item. */
export function availableWorkItemEmployees(
  state: CommandState,
): readonly Employee[] {
  return (state.employees ?? []).filter(
    (employee) =>
      employeeInProject(employee, state.project_id) &&
      employee.status === "active" &&
      !isExternalEmployee(state, employee.id),
  );
}

function target(d: CommandDraft, item: WorkItem): string | undefined {
  if (item.kind !== "verify") return;
  if (item.target_work_item_id) return item.target_work_item_id;
  const card = d.get("cards", item.card_id);
  const template = resolveCardTemplate(d, card);
  if (!isCompletionVerifier(template, item)) return;
  return d
    .list("work_items")
    .find(
      (w) =>
        w.card_id === item.card_id &&
        w.kind === "produce" &&
        w.template_key === template.primary_work_item_key,
    )?.id;
}

/** Independent review compares only the author of the actual delivery. */
function currentAuthorConflict(
  d: CommandDraft,
  item: WorkItem,
  employeeId: EmployeeId,
  delivery?: Delivery,
) {
  const targetId = target(d, item);
  const current =
    delivery ??
    d
      .list("deliveries")
      .filter(
        (v) =>
          v.work_item_id === targetId &&
          v.kind !== "card_completion" &&
          v.status !== "superseded",
      )
      .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
  const authorId = current
    ? d.list("runs").find((r) => r.id === current.run_id)?.assignment_id
    : d.list("work_items").find((w) => w.id === targetId)?.assignment_id;
  return (
    !!authorId &&
    d
      .list("assignments")
      .some((a) => a.id === authorId && a.employee_id === employeeId)
  );
}

function hasEmployeeOn(
  d: CommandDraft,
  work_item_ids: readonly (string | undefined)[],
  employee_id: EmployeeId,
): boolean {
  return d
    .list("assignments")
    .some(
      (a) =>
        a.scope === "work_item" &&
        work_item_ids.includes(a.work_item_id) &&
        a.employee_id === employee_id,
    );
}

/** Symmetric: assigning a producer after its reviewer must not bypass separation. */
function authorConflict(
  d: CommandDraft,
  item: WorkItem,
  employee_id: EmployeeId,
  delivery?: Delivery,
): boolean {
  if (item.kind === "verify" && item.role_id === "independent_reviewer")
    return currentAuthorConflict(d, item, employee_id, delivery);
  const counterparts =
    item.kind === "verify"
      ? [target(d, item)]
      : d
          .list("work_items")
          .filter(
            (w) =>
              w.role_id !== "independent_reviewer" && target(d, w) === item.id,
          )
          .map((w) => w.id);
  return hasEmployeeOn(d, counterparts, employee_id);
}

export function employeeConflicts(
  d: CommandDraft,
  item: WorkItem,
  employee_id: EmployeeId,
  delivery?: Delivery,
): boolean {
  return authorConflict(d, item, employee_id, delivery);
}

export function checkEmployeeSeparation(
  d: CommandDraft,
  item: WorkItem,
  employee_id?: EmployeeId,
  delivery?: Delivery,
): void {
  if (!employee_id) return;
  ensure(
    !authorConflict(d, item, employee_id, delivery),
    "invariant_violation",
    item.role_id === "independent_reviewer"
      ? "独立复核员工不能是本次交付的作者"
      : "审核员工不能是目标产出项当前或曾经的作者（完成申请同理）",
  );
}

export function selectEmployee(
  d: CommandDraft,
  item: WorkItem,
  reference?: string,
): Employee | undefined {
  if (reference !== undefined) {
    const employee = resolveEmployee(d, reference);
    checkEmployeeProject(employee, d.state.project_id);
    checkEmployeeNotExternal(d, employee.id);
    ensure(
      employee.status === "active",
      "invariant_violation",
      `员工 ${employee.id} 已停用，不能指派新工作`,
    );
    ensure(
      employee.role_id === item.role_id,
      "validation_failed",
      "员工角色必须与工作项要求一致",
    );
    checkEmployeeSeparation(d, item, employee.id);
    return employee;
  }
  const employees = d.state.employees ?? [];
  const active = employees.filter(
    (e) =>
      employeeInProject(e, d.state.project_id) &&
      e.status === "active" &&
      e.role_id === item.role_id,
  );
  if (!active.length) {
    allowLegacyUnnamed(employees, item.role_id);
    return;
  }
  const internal = availableWorkItemEmployees(d.state).filter(
    (e) => e.role_id === item.role_id,
  );
  ensure(
    internal.length,
    "invariant_violation",
    "该角色的在职员工均为外接员工，不由 Cardigan 启动，请指派其他员工",
  );
  const eligible = internal.filter((e) => !employeeConflicts(d, item, e.id));
  ensure(
    eligible.length,
    "invariant_violation",
    "该角色的在职员工均违反审核隔离要求，请指派其他员工",
  );
  return eligible.sort((a, b) => {
    const left = employeeAssignmentActivity(d, a),
      right = employeeAssignmentActivity(d, b);
    return (
      Number(left.unfinished_runs > 0) - Number(right.unfinished_runs > 0) ||
      (left.last_assigned_at ?? "").localeCompare(
        right.last_assigned_at ?? "",
      ) ||
      Number(a.id.slice(2)) - Number(b.id.slice(2))
    );
  })[0];
}

export function employeeAssignmentActivity(
  d: CommandDraft,
  employee: Employee,
) {
  const global = d.state.employee_activity?.find(
    (a) => a.employee_id === employee.id,
  );
  if (global) return global;
  const assignments = d
    .list("assignments")
    .filter((a) => a.employee_id === employee.id);
  return {
    last_assigned_at:
      assignments
        .map((a) => a.created_at)
        .sort()
        .at(-1) ?? "",
    unfinished_runs: d
      .list("runs")
      .filter(
        (r) =>
          assignments.some((a) => a.id === r.assignment_id) &&
          !["completed", "failed", "cancelled"].includes(r.status),
      ).length,
  };
}

/** Include assignments added or released earlier in this command's transaction. */
export function employeeAssignmentLoad(
  d: CommandDraft,
  employee: Employee,
): number {
  const count = (assignments: CommandState["assignments"]) =>
    assignments.filter(
      (a) => a.employee_id === employee.id && a.status === "active",
    ).length;
  const initial = count(d.state.assignments);
  const global = d.state.employee_activity?.find(
    (a) => a.employee_id === employee.id,
  );
  return (
    (global?.active_assignments ?? initial) +
    count(d.list("assignments")) -
    initial
  );
}

/** Use the explicit assign validator for each candidate; never duplicate eligibility rules. */
export function automaticEmployeeSelection(d: CommandDraft, item: WorkItem) {
  const candidates = (d.state.employees ?? [])
    .filter(
      (employee) =>
        employeeInProject(employee, d.state.project_id) &&
        employee.role_id === item.role_id,
    )
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
    .map((employee) => {
      const checked = attempt(() => selectEmployee(d, item, employee.id));
      return {
        employee,
        active_assignments: employeeAssignmentLoad(d, employee),
        reason: checked.ok ? null : checked.error.message,
      };
    });
  const eligible = candidates
    .filter((c) => c.reason === null)
    .sort(
      (a, b) =>
        a.active_assignments - b.active_assignments ||
        Number(a.employee.id.slice(2)) - Number(b.employee.id.slice(2)),
    );
  return { employee: eligible[0]?.employee, candidates };
}
