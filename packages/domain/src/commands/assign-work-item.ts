import type { Assignment } from "../entities.js";
import { hostOpsPending } from "../host-ops.js";
import type { DeliveryId, WorkItemId } from "../ids.js";
import {
  effectiveWorkItemRequirements,
  mergeMachineRequirements,
} from "../machine-requirements.js";
import {
  remoteWorkerLosses,
  remoteWorkerLossReleased,
} from "../remote-worker-loss.js";
import { isRoleActive } from "../role.js";
import { requireCardDependencyStart } from "./card-dependencies.js";
import { type CommandDraft, ensure, unwrap } from "./core.js";
import {
  checkEmployeeNotExternal,
  checkEmployeeSeparation,
  employeeAssignmentLoad,
  resolveEmployee,
  selectEmployee,
} from "./employee-assignment.js";
import { hostOpsExitConfirmation } from "./host-ops-actions.js";

import { type MachineRequirements, selectMachine } from "./machines.js";

export interface AssignWorkItemParams extends MachineRequirements {
  work_item_id: WorkItemId;
  role_id: string;
  role_version?: number;
  employee_id?: string;
  machine_id?: string;
  recovery_source?: "main" | "backup";
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
  requireCardDependencyStart(d, d.card(item.card_id));
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
  const previous = existing.find((a) => a.id === item.assignment_id);
  const recovery =
    previous?.status === "released"
      ? remoteWorkerLosses(d.state.events).find(
          (loss) =>
            loss.assignment_id === previous.id &&
            loss.work_item_id === item.id &&
            remoteWorkerLossReleased(d.state.events, loss.action_id) &&
            hostOpsExitConfirmation(d.state, loss.action_id).status ===
              "confirmed",
        )
      : undefined;
  if (recovery) {
    ensure(
      !existing.some((a) => hostOpsPending(d.state.events, a.id)),
      "illegal_transition",
      "Work item has a pending exit confirmation or host operation",
    );
    ensure(
      !automaticTarget &&
        (p.recovery_source === "main" || p.recovery_source === "backup"),
      "validation_failed",
      "PM must explicitly choose main or backup for recovery",
    );
    ensure(
      p.machine_id !== undefined && p.machine_id !== previous?.machine_id,
      "validation_failed",
      "Recovery requires another explicit machine",
    );
    ensure(
      p.recovery_source !== "backup" || recovery.backup,
      "validation_failed",
      "No successful backup is available",
    );
    ensure(
      existing.every((a) => a.status === "released"),
      "invariant_violation",
      "Work item still has an active Assignment",
    );
  } else if (existing.length || item.assignment_id) {
    const current = previous;
    ensure(
      existing.every(
        (a) =>
          a.id === current?.id ||
          (a.status === "released" &&
            remoteWorkerLosses(d.state.events).some(
              (loss) =>
                loss.assignment_id === a.id &&
                remoteWorkerLossReleased(d.state.events, loss.action_id),
            )),
      ) &&
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
      !p.recovery_source || current.recovery?.source === p.recovery_source,
      "stale_target",
      "Recovery choice is already fixed",
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
  ensure(
    !p.recovery_source || recovery,
    "validation_failed",
    "Recovery requires a released remote loss",
  );
  const employee = selectEmployee(
    d,
    item,
    p.employee_id ?? (recovery ? previous?.employee_id : undefined),
  );
  const selection =
    automaticTarget && employee
      ? employeeAssignmentLoad(d, employee)
      : undefined;
  const required = unwrap(
    mergeMachineRequirements(
      unwrap(effectiveWorkItemRequirements(item.requirements, role)),
      {
        ...(p.os === undefined ? {} : { os: p.os }),
        ...(p.arch === undefined ? {} : { arch: p.arch }),
        ...(p.required_tags === undefined ? {} : { tags: p.required_tags }),
      },
    ),
  );
  const { machine_id, audit } = selectMachine(
    d,
    item,
    required,
    role.worktree,
    p.machine_id,
  );
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
    machine_id,
    runtime_ref: null,
    ...(recovery
      ? {
          recovery: {
            source: p.recovery_source as "main" | "backup",
            previous_assignment_id: recovery.assignment_id,
            ...(p.recovery_source === "backup"
              ? { backup: recovery.backup }
              : {}),
          },
        }
      : {}),
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
      machine_id,
      ...(assignment.recovery ? { recovery: { ...assignment.recovery } } : {}),
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
  if (audit)
    d.emit("machine_selected", card.id, {
      work_item_id: item.id,
      assignment_id: id,
      machine_id,
      ...audit,
    });
  return assignment;
}
