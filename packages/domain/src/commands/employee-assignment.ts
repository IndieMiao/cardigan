import { type Employee, employeeNameKey } from "../employee.js";
import type { WorkItem } from "../entities.js";
import type { EmployeeId } from "../ids.js";
import { isCompletionVerifier } from "../templates.js";
import { type CommandDraft, type CommandState, ensure } from "./core.js";
import { resolveCardTemplate } from "./templates.js";

/** Resolve an explicit ID, or an active display name, without accepting identity claims. */
export function resolveEmployee(d: CommandDraft, reference: string): Employee {
  const employees = d.state.employees ?? [];
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

function isExternalEmployee(
  state: CommandState,
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
      employee.status === "active" && !isExternalEmployee(state, employee.id),
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

const INDEPENDENT_REVIEWER = "independent_reviewer";

/**
 * Invariant 15/16 extension (P2a-14 ②): an independent_reviewer verify item is
 * isolated from every other verify item on the same card, in both directions.
 * Other verify roles stay unseparated from each other.
 */
function verifierCounterparts(d: CommandDraft, item: WorkItem): string[] {
  if (item.kind !== "verify") return [];
  return d
    .list("work_items")
    .filter(
      (w) =>
        w.id !== item.id &&
        w.card_id === item.card_id &&
        w.kind === "verify" &&
        (item.role_id === INDEPENDENT_REVIEWER ||
          w.role_id === INDEPENDENT_REVIEWER),
    )
    .map((w) => w.id);
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
): boolean {
  const counterparts =
    item.kind === "verify"
      ? [target(d, item)]
      : d
          .list("work_items")
          .filter((w) => target(d, w) === item.id)
          .map((w) => w.id);
  return hasEmployeeOn(d, counterparts, employee_id);
}

export function employeeConflicts(
  d: CommandDraft,
  item: WorkItem,
  employee_id: EmployeeId,
): boolean {
  return (
    authorConflict(d, item, employee_id) ||
    hasEmployeeOn(d, verifierCounterparts(d, item), employee_id)
  );
}

export function checkEmployeeSeparation(
  d: CommandDraft,
  item: WorkItem,
  employee_id?: EmployeeId,
): void {
  if (!employee_id) return;
  ensure(
    !authorConflict(d, item, employee_id),
    "invariant_violation",
    "审核员工不能是目标产出项当前或曾经的作者（完成申请同理）",
  );
  ensure(
    !hasEmployeeOn(d, verifierCounterparts(d, item), employee_id),
    "invariant_violation",
    "独立复核员工不能同时是同一张卡上其它验证项当前或曾经的负责人",
  );
}

export function selectEmployee(
  d: CommandDraft,
  item: WorkItem,
  reference?: string,
): Employee | undefined {
  if (reference !== undefined) {
    const employee = resolveEmployee(d, reference);
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
  const active = (d.state.employees ?? []).filter(
    (e) => e.status === "active" && e.role_id === item.role_id,
  );
  if (!active.length) return;
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
  const activity = (employee: Employee) => {
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
  };
  return eligible.sort((a, b) => {
    const left = activity(a),
      right = activity(b);
    return (
      Number(left.unfinished_runs > 0) - Number(right.unfinished_runs > 0) ||
      (left.last_assigned_at ?? "").localeCompare(
        right.last_assigned_at ?? "",
      ) ||
      Number(a.id.slice(2)) - Number(b.id.slice(2))
    );
  })[0];
}
