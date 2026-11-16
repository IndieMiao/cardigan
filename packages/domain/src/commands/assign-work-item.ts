import type { Assignment } from "../entities.js";
import type { DeliveryId, WorkItemId } from "../ids.js";
import { isRoleActive } from "../role.js";
import { type CommandDraft, ensure } from "./core.js";
import {
  checkEmployeeNotExternal,
  checkEmployeeSeparation,
  employeeAssignmentLoad,
  resolveEmployee,
  selectEmployee,
} from "./employee-assignment.js";

import { type MachineRequirements, selectMachine } from "./machines.js";

export interface AssignWorkItemParams extends MachineRequirements {
  work_item_id: WorkItemId;
  role_id: string;
  role_version?: number;
  employee_id?: string;
  machine_id?: string;
}

/** Shared invariant checks; callers establish PM or system authority first. */
export function assignWorkItem(
  d: CommandDraft,
  p: AssignWorkItemParams,
  automaticTarget?: DeliveryId | "first_producer",
) {
  ensure(
    p.role_id !== "host_ops",
    "validation_failed",
    "host_ops 只能创建常驻 Assignment，不能指派工作项",
  );
  const item = d.work(p.work_item_id);
  ensure(
    !d.card(item.card_id).hold,
    "illegal_transition",
    "卡片已暂停，请先解除暂停",
  );
  ensure(
    item.role_id === p.role_id,
    "validation_failed",
    "Assignment role must match the work item",
  );
  const role = d.state.roles
    .filter(
      (r) =>
        r.role_id === p.role_id &&
        (p.role_version === undefined || r.role_version === p.role_version),
    )
    .sort((a, b) => b.role_version - a.role_version)[0];
  ensure(role, "not_found", "Role version was not found");
  const existing = d
    .list("assignments")
    .filter((a) => a.scope === "work_item" && a.work_item_id === item.id);
  ensure(
    !item.replaced_by_work_item_id,
    "illegal_transition",
    "已被替换的验证项不能再指派",
  );
  if (existing.length || item.assignment_id) {
    const current = existing[0];
    ensure(
      existing.length === 1 &&
        current &&
        current.id === item.assignment_id &&
        current.status === "active" &&
        current.role_id === p.role_id &&
        (p.role_version === undefined ||
          current.role_version === p.role_version),
      "invariant_violation",
      "A work item has one persistent assignment",
    );
    ensure(
      p.machine_id === undefined || p.machine_id === current.machine_id,
      "invariant_violation",
      "Assignment 的机器创建后不能修改",
    );
    const employee_id =
      p.employee_id === undefined
        ? current.employee_id
        : resolveEmployee(d, p.employee_id).id;
    checkEmployeeNotExternal(d, employee_id);
    ensure(
      p.employee_id === undefined || employee_id === current.employee_id,
      "invariant_violation",
      "Assignment 的员工创建后不能修改",
    );
    checkEmployeeSeparation(d, item, current.employee_id);
    return current;
  }
  ensure(
    isRoleActive(d.state.roles, p.role_id),
    "validation_failed",
    "停用的角色不能被新指派",
  );
  const card = d.card(item.card_id);
  ensure(
    card.status !== "done" && card.status !== "cancelled",
    "illegal_transition",
    "Card is closed",
  );
  const employee = selectEmployee(d, item, p.employee_id);
  const selection =
    automaticTarget && employee
      ? employeeAssignmentLoad(d, employee)
      : undefined;
  const machine = selectMachine(d.list("machines"), {
    ...p,
    required_tags: [
      ...(role.required_machine_tags ?? []),
      ...(p.required_tags ?? []),
    ],
  });
  const id = d.ids.next(d.state.project_id, "assignment");
  const token_id = `assignment:${JSON.stringify([d.state.project_id, id])}`;
  const assignment: Assignment = {
    id,
    scope: "work_item" as const,
    work_item_id: item.id,
    ...(employee ? { employee_id: employee.id } : {}),
    role_id: role.role_id,
    role_version: role.role_version,
    status: "active" as const,
    runtime_state: "not_provisioned" as const,
    machine_id: machine.id,
    runtime_ref: null,
    mcp_token_id: token_id,
    created_at: d.now,
  };
  d.put("assignments", assignment);
  d.put("work_items", { ...item, assignment_id: id });
  d.token_requests.push({
    token_id,
    assignment_id: id,
    role_version: role.role_version,
    allowed_tools: role.allowed_tools,
  });
  d.emit(
    "work_item_assigned",
    card.id,
    {
      work_item_id: item.id,
      assignment_id: id,
      machine_id: machine.id,
      ...(automaticTarget
        ? {
            rule: "C-225/auto-assign",
            ...(automaticTarget === "first_producer"
              ? { first_producer: true }
              : { delivery_id: automaticTarget }),
            assigned_by: "system",
            selection_order: [
              "active_assignments_ascending",
              "employee_number_ascending",
            ],
            selection: {
              active_assignments: selection ?? 0,
              employee_number: Number(employee?.id.slice(2)),
            },
          }
        : {}),
      ...(employee ? { employee_id: employee.id } : {}),
    },
    {
      type: "status_change",
      body: automaticTarget
        ? `系统按角色 ${role.role_id} 自动指派 ${item.id} 给 ${employee?.id}（${automaticTarget === "first_producer" ? "首个产出项" : `交付 ${automaticTarget}`}；活跃 Assignment 数 ${selection ?? 0}，负载最少、员工编号依次优先）`
        : `Assigned ${item.id} to ${role.role_id}`,
      work_item_id: item.id,
    },
  );
  return assignment;
}
