import type {
  Actor,
  Assignment,
  ProjectId,
  Result,
  RoleReference,
} from "@cardigan/domain";
import { holdsStandingOnlyTools, isStandingOnlyTool } from "@cardigan/domain";
import type { McpBackend, McpToken } from "./backend.js";

/** MCP callers are always assignments: a token belongs to one assignment. */
export type AssignmentActor = Extract<Actor, { readonly kind: "assignment" }>;

/** Everything authenticated tool handlers are allowed to know about the caller. */
export interface Identity {
  readonly actor: AssignmentActor;
  readonly token: McpToken;
  readonly assignment: Assignment;
  readonly role: RoleReference;
}

const unauthorized = (message: string): Result<never> => ({
  ok: false,
  error: { code: "unauthorized", message },
});

/**
 * Resolve a Bearer token to an assignment identity (§9.1).
 *
 * The token decides who the caller is: the assignment, its role version and the
 * tools it may use all come from the stored token row, never from arguments.
 * Unknown, revoked and orphaned tokens are indistinguishable to the caller.
 *
 * §3.6 / M4.4: a token only works while its Assignment is active. Revoking the
 * token on release is the first line of defence; this check is the second, and
 * it also covers suspended Assignments whose token has not been rotated yet.
 */
export function authenticate(
  store: McpBackend,
  token: string | undefined,
): Result<Identity> {
  if (token === undefined || token.length === 0) {
    return unauthorized("missing bearer token");
  }

  const record = store.verifyToken(token);
  if (record === undefined) {
    return unauthorized("invalid bearer token");
  }

  const lookup = store.uow.read((tx) => {
    const assignment = tx.assignments.get(
      record.project_id,
      record.assignment_id,
    );
    if (assignment === undefined) {
      return undefined;
    }
    return {
      assignment,
      role: tx.roles.get(record.project_id, {
        role_id: assignment.role_id,
        role_version: record.role_version,
      }),
    };
  });

  if (lookup === undefined || lookup.assignment.status !== "active") {
    return unauthorized("invalid bearer token");
  }

  const role: RoleReference = lookup.role ?? {
    role_id: lookup.assignment.role_id,
    role_version: record.role_version,
    allowed_tools: record.allowed_tools,
    capabilities: [],
  };

  return {
    ok: true,
    value: {
      actor: {
        kind: "assignment",
        project_id: record.project_id as ProjectId,
        assignment_id: record.assignment_id,
        role_id: role.role_id,
        role_version: role.role_version,
        // §9.1: the token carries the tool scope; the role row only adds
        // capabilities and the human-readable role id.
        allowed_tools: record.allowed_tools.filter(
          (tool) =>
            (tool !== "issue_instruction" ||
              (lookup.assignment.scope === "standing" &&
                lookup.assignment.role_id === "pm" &&
                lookup.assignment.standing_mode === "ops")) &&
            (!isStandingOnlyTool(tool) ||
              holdsStandingOnlyTools(lookup.assignment)),
        ),
        capabilities: role.capabilities,
      },
      token: record,
      assignment: lookup.assignment,
      role,
    },
  };
}

/** Parse `Authorization: Bearer <token>`; anything else yields `undefined`. */
export function bearerToken(
  header: string | string[] | undefined,
): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) {
    return undefined;
  }
  const match = /^Bearer[ ]+(\S+)$/i.exec(value.trim());
  return match?.[1];
}
