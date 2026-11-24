import type { Actor, Assignment, Event, RoleReference } from "../entities.js";
import type { Result } from "../errors.js";
import { eventsOfType } from "../event-index.js";
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
import { selectStandingEmployee } from "./employee-assignment.js";
import type { RotateStandingPmResult } from "./pm-rotate.js";

const sorted = (values: readonly string[] | undefined) =>
  JSON.stringify([...(values ?? [])].sort());

/** Launch and policy fields a domain role reference carries. */
function sameReference(a: RoleReference, b: RoleReference) {
  return (
    sorted(a.allowed_tools) === sorted(b.allowed_tools) &&
    sorted(a.capabilities) === sorted(b.capabilities) &&
    sorted(a.required_capabilities) === sorted(b.required_capabilities) &&
    a.launch_profile_ref === b.launch_profile_ref &&
    a.worktree === b.worktree
  );
}

/**
 * C-613: the version whose audited system upgrade `version` carries. A real
 * upgrade audit (`host_role_upgraded` to exactly this version) carries itself.
 * A `metadata_only` audit carries its source version's, and only while the
 * two versions keep the same policy and launch fields (the host also checks
 * the full policy hash before writing one). Undefined: no audit reaches it,
 * e.g. a version edited by hand.
 */
export function deploymentAuditedVersion(
  state: {
    readonly roles: readonly RoleReference[];
    readonly events: readonly Event[];
  },
  roleId: string,
  version: number,
): number | undefined {
  const reference = (v: number) =>
    state.roles.find((r) => r.role_id === roleId && r.role_version === v);
  let current = version;
  for (;;) {
    // C-649: first match from the type index, same as scanning every event.
    const audit = eventsOfType(state.events, "host_role_upgraded").find((e) => {
      const p = e.payload as Record<string, unknown>;
      return (
        e.type === "host_role_upgraded" &&
        e.actor.kind === "system" &&
        e.card_id === undefined &&
        p.role_id === roleId &&
        p.to_version === current
      );
    });
    if (!audit) return undefined;
    const p = audit.payload as Record<string, unknown>;
    if (p.metadata_only !== true) return current;
    const from = p.from_version;
    const target = reference(current);
    const source = typeof from === "number" ? reference(from) : undefined;
    if (
      typeof from !== "number" ||
      from >= current ||
      !target ||
      !source ||
      !sameReference(source, target)
    )
      return undefined;
    current = from;
  }
}

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
    const audited =
      latest &&
      deploymentAuditedVersion(state, previous.role_id, latest.role_version);
    ensure(
      latest &&
        latest.role_version > previous.role_version &&
        audited !== undefined &&
        audited > previous.role_version,
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
    const employeeId =
      previous.role_id === "host_ops"
        ? unwrap(
            selectStandingEmployee(state, "host_ops", previous.employee_id),
          )?.id
        : previous.employee_id;
    const { session_ref: _oldSession, ...identity } = previous;
    const assignment: Assignment = {
      ...identity,
      ...(employeeId ? { employee_id: employeeId } : {}),
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
