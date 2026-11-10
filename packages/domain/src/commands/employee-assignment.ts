import { type Employee, employeeNameKey } from "../employee.js";
import type { WorkItem } from "../entities.js";
import type { EmployeeId } from "../ids.js";
import {
  developmentCardTemplate,
  PM_ACCEPTANCE_WORK_ITEM_KEY,
} from "../templates.js";
import { type CommandDraft, ensure } from "./core.js";

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

function target(d: CommandDraft, item: WorkItem): string | undefined {
  if (item.kind !== "verify") return;
  if (item.target_work_item_id) return item.target_work_item_id;
  if (item.template_key !== PM_ACCEPTANCE_WORK_ITEM_KEY) return;
  const card = d.get("cards", item.card_id);
  const template =
    d.ports?.templates?.find((t) => t.id === card.template) ??
    developmentCardTemplate;
  return d
    .list("work_items")
    .find(
      (w) =>
        w.card_id === item.card_id &&
        w.kind === "produce" &&
        w.template_key === template.primary_work_item_key,
    )?.id;
}

/** Symmetric: assigning a producer after its reviewer must not bypass separation. */
export function employeeConflicts(
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
  return d
    .list("assignments")
    .some(
      (a) =>
        a.scope === "work_item" &&
        counterparts.includes(a.work_item_id) &&
        a.employee_id === employee_id,
    );
}

export function checkEmployeeSeparation(
  d: CommandDraft,
  item: WorkItem,
  employee_id?: EmployeeId,
): void {
  ensure(
    !employee_id || !employeeConflicts(d, item, employee_id),
    "invariant_violation",
    "审核员工不能是目标产出项当前或曾经的作者（完成申请同理）",
  );
}

export function selectEmployee(
  d: CommandDraft,
  item: WorkItem,
  reference?: string,
): Employee | undefined {
  if (reference !== undefined) {
    const employee = resolveEmployee(d, reference);
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
  const eligible = active.filter((e) => !employeeConflicts(d, item, e.id));
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
