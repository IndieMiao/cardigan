import type { Actor, Assignment } from "../entities.js";
import type { Result } from "../errors.js";
import { pendingHostOpsActions } from "../host-ops.js";
import type { AssignmentId } from "../ids.js";
import { isRoleActive } from "../role.js";
import { transition } from "../transitions.js";
import {
  type CommandDraft,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { selectStandingEmployee } from "./employee-assignment.js";

function target(d: CommandDraft) {
  ensure(
    d.actor.kind === "human",
    "unauthorized",
    "只有人可以给主机运维换版本",
  );
  const candidates = d
    .list("assignments")
    .filter((a) => a.role_id === "host_ops" && a.status !== "released");
  ensure(
    candidates.length === 1,
    "validation_failed",
    "需要恰好一个常驻主机运维 Assignment",
  );
  const previous = candidates[0] as Assignment;
  ensure(
    previous.scope === "standing" && !previous.external,
    "illegal_transition",
    "只能轮换托管的常驻主机运维",
  );
  const latest = d.state.roles
    .filter((r) => r.role_id === "host_ops")
    .sort((a, b) => b.role_version - a.role_version)[0];
  ensure(
    latest && isRoleActive(d.state.roles, "host_ops"),
    "validation_failed",
    "host_ops 角色未启用",
  );
  ensure(
    latest.role_version >= previous.role_version,
    "invariant_violation",
    "host_ops 最新版本低于在岗版本",
  );
  const employeeId =
    latest.role_version === previous.role_version
      ? previous.employee_id
      : unwrap(
          selectStandingEmployee(
            d.state.employees ?? [],
            d.state.project_id,
            "host_ops",
            previous.employee_id,
          ),
        )?.id;
  ensure(
    !pendingHostOpsActions(d.state.events).some(
      (a) => a.assignment_id === previous.id,
    ),
    "illegal_transition",
    "主机运维有未完成的运维动作",
  );
  ensure(
    !d
      .list("runs")
      .some(
        (r) =>
          r.assignment_id === previous.id &&
          (r.dispatch_stop || r.inactivity_stop),
      ),
    "illegal_transition",
    "主机运维有自动停止操作，等待其完成后再轮换",
  );
  return { previous, latest, employeeId };
}

/** Read-only preflight; failed exit confirmation must leave the old identity on duty. */
export function prepareHostOpsRotation(state: CommandState, actor: Actor) {
  return command(state, actor, "rotate_host_ops_assignment", undefined, (d) => {
    const { previous, latest } = target(d);
    ensure(
      previous.status === "active",
      "illegal_transition",
      "主机运维不在岗，不能轮换",
    );
    return {
      previous: previous as Assignment,
      to_version: latest.role_version,
      unchanged: previous.role_version === latest.role_version,
    };
  });
}

/** Host calls only after exit and credential cleanup; retries preserve one replacement. */
export function finishHostOpsRotation(
  state: CommandState,
  actor: Actor,
  p: {
    readonly previous_assignment_id: AssignmentId;
    readonly to_version: number;
  },
  ports: CommandPorts,
): Result<CommandEffect<{ previous: Assignment; assignment: Assignment }>> {
  return command(state, actor, "rotate_host_ops_assignment", ports, (d) => {
    const { previous, latest, employeeId } = target(d);
    ensure(
      previous.id === p.previous_assignment_id && previous.status === "active",
      "stale_target",
      "轮换对象已改变",
    );
    ensure(
      latest.role_version === p.to_version &&
        latest.role_version > previous.role_version,
      "stale_target",
      "轮换期间角色版本已改变，请重新运行 rotate",
    );
    const assignment: Assignment = {
      id: d.ids.next(d.state.project_id, "assignment"),
      scope: "standing",
      role_id: "host_ops",
      role_version: latest.role_version,
      status: "active",
      runtime_state: "not_provisioned",
      machine_id: previous.machine_id,
      runtime_ref: null,
      mcp_token_id: "host-ops",
      created_at: d.now,
      ...(employeeId ? { employee_id: employeeId } : {}),
    };
    d.put("assignments", assignment);
    for (const cursor of d.list("cursors"))
      if (cursor.assignment_id === previous.id)
        d.put("cursors", { ...cursor, assignment_id: assignment.id });
    const runs = d
      .list("runs")
      .filter(
        (r) =>
          r.assignment_id === previous.id &&
          !["completed", "failed", "cancelled"].includes(r.status),
      );
    for (const run of runs)
      d.put("runs", {
        ...run,
        status: unwrap(transition("run", run.status, "cancel")),
        outcome: "failed",
        summary: "Standing host operations rotated to a new role version",
        finished_at: d.now,
      });
    d.put("assignments", {
      ...previous,
      status: unwrap(transition("assignment", previous.status, "release")),
      runtime_state: unwrap(
        transition("runtime", previous.runtime_state, "release"),
      ),
      released_at: d.now,
    });
    d.emit("assignment_released", undefined, {
      assignment_id: previous.id,
      worktree_path: null,
      branch: null,
      token_id: previous.mcp_token_id,
      runtime_ref: previous.runtime_ref ? { ...previous.runtime_ref } : null,
      replaced_by: assignment.id,
    });
    d.emit("host_ops_rotated", undefined, {
      previous_assignment_id: previous.id,
      assignment_id: assignment.id,
      from_version: previous.role_version,
      to_version: assignment.role_version,
      employee_id: assignment.employee_id ?? null,
      cancelled_run_ids: runs.map((r) => r.id),
    });
    return { previous, assignment };
  });
}
