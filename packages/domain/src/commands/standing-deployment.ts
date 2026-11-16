import type { Actor, Assignment } from "../entities.js";
import type { Result } from "../errors.js";
import type { AssignmentId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import type { RotateStandingPmResult } from "./pm-rotate.js";

/** Host maintenance only; the upgrade audit must come from the deployed default pack. */
export function rotateStandingAfterDeployment(
  state: CommandState,
  actor: Actor,
  assignmentId: AssignmentId,
  ports: CommandPorts,
): Result<CommandEffect<RotateStandingPmResult>> {
  return command(state, actor, "rotate_deployed_pm", ports, (d) => {
    ensure(
      actor.kind === "system",
      "unauthorized",
      "只有系统可以自动轮换常驻会话",
    );
    const previous = d.get("assignments", assignmentId);
    ensure(
      previous.scope === "standing" &&
        previous.role_id !== "pm" &&
        !previous.external &&
        previous.status === "active",
      "illegal_transition",
      "常驻会话不满足自动轮换条件",
    );
    const latest = state.roles
      .filter((r) => r.role_id === previous.role_id && r.status !== "inactive")
      .sort((a, b) => b.role_version - a.role_version)[0];
    ensure(
      latest &&
        latest.role_version > previous.role_version &&
        state.events.some(
          (e) =>
            e.actor.kind === "system" &&
            e.type === "host_role_upgraded" &&
            (e.payload as Record<string, unknown>).role_id ===
              previous.role_id &&
            (e.payload as Record<string, unknown>).to_version ===
              latest.role_version,
        ),
      "illegal_transition",
      "没有已部署默认包的升级审计",
    );
    ensure(
      !d
        .list("runs")
        .some(
          (r) =>
            r.assignment_id === previous.id &&
            !["completed", "failed", "cancelled"].includes(r.status),
        ),
      "illegal_transition",
      "常驻会话忙碌，等待空闲",
    );
    const { session_ref: _oldSession, ...identity } = previous;
    const assignment: Assignment = {
      ...identity,
      id: d.ids.next(state.project_id, "assignment"),
      role_version: latest.role_version,
      runtime_state: "not_provisioned" as const,
      runtime_ref: null,
      created_at: d.now,
    };
    d.put("assignments", assignment);
    d.put("assignments", {
      ...previous,
      status: "released",
      runtime_state: unwrap(
        transition("runtime", previous.runtime_state, "release"),
      ),
      released_at: d.now,
    });
    for (const cursor of d.list("cursors"))
      if (cursor.assignment_id === previous.id)
        d.put("cursors", { ...cursor, assignment_id: assignment.id });
    d.emit("assignment_released", undefined, {
      assignment_id: previous.id,
      runtime_ref: previous.runtime_ref ? { ...previous.runtime_ref } : null,
      token_id: previous.mcp_token_id,
      replaced_by: assignment.id,
    });
    d.emit("standing_role_rotated", undefined, {
      role_id: previous.role_id,
      previous_assignment_id: previous.id,
      assignment_id: assignment.id,
      from_version: previous.role_version,
      to_version: assignment.role_version,
      notice: `${previous.role_id} 默认包已升级，空闲常驻会话已自动轮换。`,
    });
    return {
      previous,
      assignment,
      unchanged: false,
      from_version: previous.role_version,
      to_version: assignment.role_version,
      decisions: [],
      human_actions: [],
      cancelled_run_ids: [],
    };
  });
}
