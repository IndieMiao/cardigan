import type { Actor, Assignment } from "../entities.js";
import type { Result } from "../errors.js";
import { isRoleActive } from "../role.js";
import {
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import {
  resolveEmployee,
  selectStandingEmployee,
} from "./employee-assignment.js";

/** Human bootstrap only; operational tools and their execution are separate commands. */
export function createHostOpsAssignment(
  state: CommandState,
  actor: Actor,
  p: { readonly employee_id?: string },
  ports: CommandPorts,
): Result<CommandEffect<{ assignment: Assignment; reused: boolean }>> {
  return command(state, actor, "create_host_ops_assignment", ports, (d) => {
    const existing = d
      .list("assignments")
      .filter((a) => a.role_id === "host_ops" && a.status !== "released");
    ensure(
      existing.length <= 1,
      "invariant_violation",
      "项目中有多个主机运维 Assignment",
    );
    const current = existing[0];
    if (current) {
      ensure(
        current.scope === "standing" && current.status === "active",
        "illegal_transition",
        "已有主机运维 Assignment 不是 active 常驻身份",
      );
      ensure(
        p.employee_id === undefined ||
          resolveEmployee(d, p.employee_id).id === current.employee_id,
        "invariant_violation",
        "Assignment 的员工创建后不能修改",
      );
      return { assignment: current, reused: true };
    }
    ensure(
      isRoleActive(state.roles, "host_ops"),
      "validation_failed",
      "先登记启用的 host_ops 角色",
    );
    const role = state.roles
      .filter((r) => r.role_id === "host_ops")
      .sort((a, b) => b.role_version - a.role_version)[0];
    ensure(role, "not_found", "host_ops 角色不存在");
    const employee = unwrap(
      selectStandingEmployee(
        state.employees ?? [],
        state.project_id,
        "host_ops",
        p.employee_id,
      ),
    );
    const id = d.ids.next(state.project_id, "assignment");
    const assignment: Assignment = {
      id,
      scope: "standing",
      role_id: "host_ops",
      role_version: role.role_version,
      ...(employee ? { employee_id: employee.id } : {}),
      status: "active",
      runtime_state: "not_provisioned",
      machine_id: "local",
      runtime_ref: null,
      mcp_token_id: `assignment:${JSON.stringify([state.project_id, id])}`,
      created_at: d.now,
    };
    d.put("assignments", assignment);
    d.emit("host_ops_assignment_created", undefined, {
      assignment_id: id,
      ...(employee ? { employee_id: employee.id } : {}),
    });
    return { assignment, reused: false };
  });
}
