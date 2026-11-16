import type { Actor, Assignment } from "../entities.js";
import { hostOpsPending, pendingHostOpsActions } from "../host-ops.js";
import type { AssignmentId } from "../ids.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
} from "./core.js";
import { stoppedByHuman } from "./stop.js";

/** Host selects a verified current default; no IO or new Run occurs in these commands. */
export function beginIdleAssignmentRoleUpgrade(
  state: CommandState,
  actor: Actor,
  assignmentId: AssignmentId,
  ports: CommandPorts,
) {
  return command(state, actor, "upgrade_idle_assignment_role", ports, (d) => {
    ensure(
      actor.kind === "system",
      "unauthorized",
      "Only the system may upgrade an idle Assignment",
    );
    const previous = d.get("assignments", assignmentId);
    if (previous.role_upgrade) return previous;
    ensure(
      previous.scope === "work_item" &&
        !previous.external &&
        previous.status === "active",
      "illegal_transition",
      "Assignment is not an active managed work item",
    );
    const item = d.work(previous.work_item_id!);
    ensure(
      item.assignment_id === previous.id &&
        !["done", "cancelled"].includes(d.card(item.card_id).status) &&
        item.status !== "cancelled",
      "illegal_transition",
      "Assignment no longer owns an open work item",
    );
    ensure(
      !hostOpsPending(state.events, previous.id) &&
        !stoppedByHuman(state.events, previous.id),
      "illegal_transition",
      "Assignment has a pending host operation or human stop",
    );
    ensure(
      !pendingHostOpsActions(state.events).some((action) => {
        const owner = state.assignments.find(
          (a) => a.id === action.assignment_id,
        );
        return (
          previous.worktree_path &&
          owner?.machine_id === previous.machine_id &&
          owner.worktree_path === previous.worktree_path
        );
      }) &&
        !state.assignments.some(
          (a) =>
            a.role_upgrade &&
            previous.worktree_path &&
            a.machine_id === previous.machine_id &&
            a.worktree_path === previous.worktree_path,
        ),
      "illegal_transition",
      "Worktree has a pending session operation",
    );
    ensure(
      !state.runs.some((r) => {
        const owner = state.assignments.find((a) => a.id === r.assignment_id);
        return (
          (r.assignment_id === previous.id ||
            (previous.worktree_path &&
              owner?.machine_id === previous.machine_id &&
              owner.worktree_path === previous.worktree_path)) &&
          (!["completed", "failed", "cancelled"].includes(r.status) ||
            r.dispatch_stop ||
            r.inactivity_stop ||
            (r.launch_publication &&
              !["started", "exited"].includes(r.launch_publication.phase)))
        );
      }),
      "illegal_transition",
      "Assignment or worktree is busy; wait for its Run to finish",
    );
    const latest = state.roles
      .filter((r) => r.role_id === previous.role_id)
      .sort((a, b) => b.role_version - a.role_version)[0];
    ensure(
      latest &&
        latest.status !== "inactive" &&
        latest.role_version > previous.role_version,
      "illegal_transition",
      "No newer active role version",
    );
    const next = {
      ...previous,
      role_upgrade: {
        role_version: latest.role_version,
        previous_runtime_ref: previous.runtime_ref,
      },
    };
    d.put("assignments", next);
    d.emit("assignment_role_upgrade_started", item.card_id, {
      assignment_id: previous.id,
      from_version: previous.role_version,
      to_version: latest.role_version,
      reason: "default_role_upgraded",
      old_runtime_ref: previous.runtime_ref
        ? { ...previous.runtime_ref }
        : null,
    });
    return next;
  });
}

/** Called only after the host confirms the exact old session has exited. */
export function finishIdleAssignmentRoleUpgrade(
  state: CommandState,
  actor: Actor,
  assignmentId: AssignmentId,
  ports: CommandPorts,
) {
  return command(state, actor, "upgrade_idle_assignment_role", ports, (d) => {
    ensure(
      actor.kind === "system",
      "unauthorized",
      "Only the system may settle a role upgrade",
    );
    const previous = d.get("assignments", assignmentId);
    if (!previous.role_upgrade) return previous;
    ensure(
      !state.runs.some(
        (r) =>
          r.assignment_id === previous.id &&
          !["completed", "failed", "cancelled"].includes(r.status),
      ),
      "illegal_transition",
      "Assignment has an unfinished Run",
    );
    ensure(
      JSON.stringify(previous.runtime_ref) ===
        JSON.stringify(previous.role_upgrade.previous_runtime_ref),
      "illegal_transition",
      "Session changed during role upgrade",
    );
    const {
      role_upgrade: upgrade,
      session_ref: _session,
      ...identity
    } = previous;
    const next: Assignment = {
      ...identity,
      role_version: upgrade.role_version,
      runtime_ref: null,
      runtime_state:
        previous.status === "released"
          ? ("released" as const)
          : ("not_provisioned" as const),
    };
    d.put("assignments", next);
    const cardId =
      previous.scope === "work_item"
        ? d.work(previous.work_item_id).card_id
        : undefined;
    const handoff = `默认角色已升级：v${previous.role_version} → v${next.role_version}。空闲会话已替换；保留员工、分支和工作区，新会话先读卡片和 get_updates。`;
    d.emit(
      "session_replaced",
      cardId,
      {
        assignment_id: previous.id,
        reason: "default_role_upgraded",
        from_version: previous.role_version,
        to_version: next.role_version,
        old_runtime_ref: upgrade.previous_runtime_ref
          ? { ...upgrade.previous_runtime_ref }
          : null,
        handoff,
      },
      { type: "handoff", body: handoff },
    );
    return next;
  });
}
