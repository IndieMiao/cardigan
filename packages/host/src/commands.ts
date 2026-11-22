import type {
  Actor,
  Assignment,
  Card,
  Clock,
  CommandEffect,
  CommandPorts,
  CommandState,
  Employee,
  ProjectId,
  Result,
  Role,
  RoleReference,
  WorkItem,
} from "@cardigan/domain";
import {
  applyStandingMode,
  holdsPublicationTool,
  holdsStandingOnlyTools,
  isStandingOnlyTool,
  managedPmOffice,
  standingModeFromTools,
  standingTools,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import {
  getRoleVersion,
  type IssuedToken,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";

/** One clock for every host-side command that does not inject its own. */
export const wallClock: Clock = { now: () => new Date().toISOString() };

/** Assignment, its fixed Role version, and the card/work item it serves. */
export interface LaunchEntities {
  readonly assignment: Assignment;
  readonly role: Role;
  readonly employee?: Employee | undefined;
  readonly card?: Card | undefined;
  readonly workItem?: WorkItem | undefined;
}

export function launchEntities(
  store: Store,
  project: ProjectId,
  assignment_id: Assignment["id"],
): LaunchEntities {
  return store.uow.run((tx) => {
    const assignment = tx.assignments.get(project, assignment_id);
    if (assignment === undefined)
      throw new Error(`Assignment ${assignment_id} 不存在`);
    const role = getRoleVersion(
      tx,
      project,
      assignment.role_id,
      assignment.role_version,
    );
    if (role === undefined)
      throw new Error(
        `角色 ${assignment.role_id} v${assignment.role_version} 不存在`,
      );
    const employee = assignment.employee_id
      ? tx.employees.get(assignment.employee_id)
      : undefined;
    if (assignment.scope !== "work_item") return { assignment, role, employee };
    const workItem = tx.work_items.get(project, assignment.work_item_id);
    const card =
      workItem === undefined
        ? undefined
        : tx.cards.get(project, workItem.card_id);
    return { assignment, role, employee, workItem, card };
  });
}

/**
 * Issue a fresh token for an Assignment and revoke its still valid ones (§9.1,
 * §10.2). The plaintext token is only ever handed to the run directory.
 *
 * §7.1 / §10.4 / M4.5: a standing PM's tool scope comes from its
 * `standing_mode`, not from whatever token it happened to hold. A row written
 * before the field existed is inferred once from its newest token and written
 * back before this issuance, so every path (CLI start, Dispatcher restart,
 * `token issue`) produces the same scope. Work-item Assignments keep the M3.T2
 * rule within one role version: never wider than the token being replaced.
 * A system-audited default role upgrade starts a new tool policy after retirement.
 */
export function issueAssignmentToken(
  store: Store,
  project: ProjectId,
  entities: Pick<LaunchEntities, "assignment" | "role">,
): IssuedToken {
  return store.uow.run((tx) => {
    let assignment =
      tx.assignments.get(project, entities.assignment.id) ??
      entities.assignment;
    if (assignment.role_upgrade)
      throw new Error("Assignment role upgrade is pending");
    if (assignment.scope === "standing" && assignment.role_id === "pm") {
      if (assignment.standing_mode === undefined) {
        const newest = tx.tokensForAssignment(project, assignment.id).at(-1);
        const stamped = applyStandingMode(
          assignment,
          newest === undefined
            ? // No token to infer from: least privilege is the safe default.
              "ops"
            : standingModeFromTools(newest.allowed_tools),
        );
        if (!stamped.ok)
          throw new Error(
            `cannot stamp standing_mode: ${stamped.error.message}`,
          );
        tx.assignments.put(project, stamped.value);
        assignment = stamped.value;
      }
      const mode = assignment.standing_mode;
      if (mode === undefined)
        throw new Error("standing mode is missing after stamping");
      return issueTokenInTransaction(tx, project, assignment.id, {
        role_version: entities.role.version,
        allowed_tools: standingTools(entities.role.allowed_tools, mode),
      });
    }
    return issueTokenInTransaction(tx, project, assignment.id, {
      role_version: entities.role.version,
      allowed_tools: entities.role.allowed_tools,
    });
  });
}

/** Read the same effective policy that every supported token issuer enforces. */
export function assignmentTokenTools(
  tx: StoreTransactionContext,
  project: ProjectId,
  assignment_id: Assignment["id"],
  role: Pick<RoleReference, "role_version" | "allowed_tools">,
): readonly RoleReference["allowed_tools"][number][] {
  const assignment = tx.assignments.get(project, assignment_id);
  if (
    assignment?.role_upgrade ||
    assignment?.idle_retirement?.phase === "stopping"
  )
    throw new Error("Assignment role upgrade is pending");
  if (assignment && assignment.role_version !== role.role_version)
    throw new Error("Assignment role version changed before token issuance");
  const previous = tx.tokensForAssignment(project, assignment_id).at(-1);
  const card =
    assignment?.scope === "work_item"
      ? tx.work_items.get(project, assignment.work_item_id)?.card_id
      : undefined;
  const upgraded =
    assignment?.scope === "work_item" &&
    !assignment.external &&
    previous !== undefined &&
    previous.role_version < assignment.role_version &&
    tx.events.listAfter(project, card, 0).some((event) => {
      const payload = event.payload as Record<string, unknown>;
      return (
        event.actor.kind === "system" &&
        event.actor.project_id === project &&
        event.type === "session_replaced" &&
        payload.assignment_id === assignment.id &&
        payload.reason === "default_role_upgraded" &&
        payload.to_version === assignment.role_version
      );
    });
  const tools =
    previous === undefined ||
    upgraded ||
    (assignment?.scope === "standing" && assignment.role_id === "pm")
      ? role.allowed_tools
      : role.allowed_tools.filter((tool) =>
          previous.allowed_tools.includes(tool),
        );
  return modeScopedTools(assignment, tools);
}

/**
 * Token issuance inside the caller's transaction, so Assignment and token commit
 * together.
 *
 * §7.1 / M4.5: a standing PM's scope is decided by its persisted `standing_mode`,
 * never by the caller. Every current path pre-filters the tools, but this
 * function is exported and a new issuance path could forget; intersecting with
 * the mode's tool set keeps the token from ever being wider than the mode
 * allows (S02, G11 cross-check).
 */
export function issueTokenInTransaction(
  tx: StoreTransactionContext,
  project: ProjectId,
  assignment_id: Assignment["id"],
  role: Pick<RoleReference, "role_version" | "allowed_tools">,
): IssuedToken {
  const allowed_tools = assignmentTokenTools(tx, project, assignment_id, role);
  for (const token of tx.tokensForAssignment(project, assignment_id)) {
    if (token.revoked_at === null) tx.revokeToken(token.id);
  }
  return tx.issueToken({
    project_id: project,
    assignment_id,
    role: {
      role_version: role.role_version,
      allowed_tools,
    },
  });
}

/** The caller's tool list, cut down to what the Assignment's mode permits. */
function modeScopedTools(
  assignment: Assignment | undefined,
  allowed_tools: readonly RoleReference["allowed_tools"][number][],
): readonly RoleReference["allowed_tools"][number][] {
  allowed_tools = allowed_tools.filter(
    (tool) => tool !== "send_owner_message" || managedPmOffice(assignment),
  );
  if (
    assignment === undefined ||
    assignment.scope !== "standing" ||
    assignment.role_id !== "pm" ||
    assignment.standing_mode === undefined
  ) {
    // V12b: work-item PMs share the pm role but never hold standing-only tools.
    return allowed_tools.filter(
      (tool) =>
        tool !== "record_decision" &&
        (tool !== "publish_artifact" ||
          (!!assignment && holdsPublicationTool(assignment))) &&
        (!isStandingOnlyTool(tool) ||
          (assignment !== undefined && holdsStandingOnlyTools(assignment))),
    );
  }
  const permitted = standingTools(
    allowed_tools as never,
    assignment.standing_mode,
  );
  return allowed_tools.filter((tool) => permitted.includes(tool as never));
}

/** One domain command in one write transaction; failures surface with their code. */
export function applyCommand<T>(
  store: Store,
  input: {
    readonly project: ProjectId;
    readonly actor: Actor;
    readonly clock?: Clock;
    readonly reduce: (
      state: CommandState,
      actor: Actor,
      ports: CommandPorts,
    ) => Result<CommandEffect<T>>;
  },
): T {
  return store.uow.run((tx) => {
    const result = input.reduce(
      loadCommandState(tx, input.project),
      input.actor,
      {
        clock: input.clock ?? wallClock,
        ids: tx.ids,
      },
    );
    if (!result.ok)
      throw new Error(`${result.error.code}: ${result.error.message}`);
    persistEffect(tx, input.project, result.value);
    return result.value.data;
  });
}
