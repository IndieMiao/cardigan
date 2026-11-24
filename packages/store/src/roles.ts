import type {
  ProjectId,
  Role,
  RoleEffect,
  RoleReference,
} from "@cardigan/domain";
import type { StoreTransactionContext } from "./store.js";

/**
 * Versioned role definitions (M2.2).
 *
 * A role's versions are append-only: the row key is
 * `(project_id, role_id, role_version)`, and a change writes a new version
 * instead of rewriting the old one, so a Run that recorded `role_version: 1`
 * keeps resolving to exactly the definition it started with (§10.1, invariant
 * 12). The stored document is the full `Role` plus `role_version`, so M1 code
 * that reads a `RoleReference` keeps working.
 */

/** What a role definition looks like in the database. */
export type RoleDocument = Role & Pick<RoleReference, "role_version">;

export function roleDocument(role: Role): RoleDocument {
  // `role_version` mirrors `version` for the M1 readers of `RoleReference`.
  return { ...role, role_version: role.version };
}

/** Narrow a stored document back to the domain `Role`. */
export function roleFromDocument(document: unknown): Role {
  const record = document as RoleDocument;
  return {
    role_id: record.role_id,
    version: record.version ?? record.role_version,
    display_name: record.display_name,
    kind: record.kind,
    core_prompt: record.core_prompt,
    ...(record.instructions === undefined
      ? {}
      : { instructions: record.instructions }),
    harness: record.harness,
    launch_profile_ref: record.launch_profile_ref,
    allowed_tools: record.allowed_tools,
    capabilities: record.capabilities,
    ...(record.status === undefined ? {} : { status: record.status }),
    abilities: record.abilities,
    worktree: record.worktree,
    required_machine_tags: record.required_machine_tags,
    ...(record.required_capabilities === undefined
      ? {}
      : { required_capabilities: record.required_capabilities }),
    ...(record.default_overlay === undefined
      ? {}
      : { default_overlay: record.default_overlay }),
  };
}

/** Command snapshots and project audit events commit together. */
export function persistRoleEffect(
  tx: StoreTransactionContext,
  project_id: ProjectId,
  effect: RoleEffect,
): void {
  for (const role of effect.roles) tx.roles.put(project_id, roleDocument(role));
  for (const event of effect.events) tx.events.append(project_id, event);
}

export interface RoleVersionSummary {
  readonly role_id: string;
  readonly version: number;
  readonly display_name: string;
  readonly harness: string;
  readonly launch_profile_ref: string;
}
type RoleReader = {
  readonly roles: Pick<StoreTransactionContext["roles"], "list">;
};

/** Every role version of a project, oldest first. */
export function listRoleVersions(
  tx: RoleReader,
  project_id: ProjectId,
): Role[] {
  return tx.roles
    .list(project_id)
    .map((reference) => roleFromDocument(reference))
    .sort((left, right) =>
      left.role_id === right.role_id
        ? left.version - right.version
        : left.role_id.localeCompare(right.role_id),
    );
}

/** One role version, or the latest version when `version` is omitted. */
export function getRoleVersion(
  tx: RoleReader,
  project_id: ProjectId,
  role_id: string,
  version?: number,
): Role | undefined {
  const versions = listRoleVersions(tx, project_id).filter(
    (role) => role.role_id === role_id,
  );
  if (version !== undefined) {
    return versions.find((role) => role.version === version);
  }
  return versions.at(-1);
}

/** The version a new definition of this role would get. */
export function nextRoleVersion(
  tx: RoleReader,
  project_id: ProjectId,
  role_id: string,
): number {
  const versions = listRoleVersions(tx, project_id).filter(
    (role) => role.role_id === role_id,
  );
  return (versions.at(-1)?.version ?? 0) + 1;
}

export interface RoleWriteResult {
  readonly role: Role;
  readonly created: boolean;
}

/**
 * Low-level legacy writer for test fixtures; application writes must use domain
 * role commands and persistRoleEffect so actor and permission checks cannot be skipped.
 *
 * - `add`: the role must not exist yet; the definition lands as version 1.
 * - `update`: writes `latest + 1`; earlier versions stay untouched.
 *
 * An explicit `version` is only honoured when it is exactly the next one, so a
 * caller can never overwrite an existing row.
 */
export function writeRole(
  tx: StoreTransactionContext,
  project_id: ProjectId,
  definition: Role,
  options: { readonly mode: "add" | "update"; readonly version?: number },
): RoleWriteResult {
  const existing = getRoleVersion(tx, project_id, definition.role_id);
  if (options.mode === "add" && existing !== undefined) {
    throw new RoleVersionError(
      `role ${definition.role_id} already exists at v${existing.version}; use "role update" to add a new version`,
    );
  }
  if (options.mode === "update" && existing === undefined) {
    throw new RoleVersionError(
      `role ${definition.role_id} does not exist; use "role add" first`,
    );
  }

  const next = nextRoleVersion(tx, project_id, definition.role_id);
  const version = options.version ?? next;
  if (version !== next) {
    throw new RoleVersionError(
      `role ${definition.role_id} would be v${next}; refusing to write v${version} (versions are append-only)`,
    );
  }

  const role: Role = { ...definition, version };
  const document: RoleDocument = roleDocument(role);
  tx.roles.put(project_id, document);
  return { role, created: options.mode === "add" };
}

/** A role version rule was violated (duplicate, missing, or not append-only). */
export class RoleVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoleVersionError";
  }
}
