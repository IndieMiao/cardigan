import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AssignmentId,
  ProjectId,
  RoleReference,
  ToolName,
} from "@cardigan/domain";

/** Only the sha256 of a token is ever stored (§9.1). */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time comparison of a presented token against a stored hash. */
export function tokenMatchesHash(token: string, storedHash: string): boolean {
  const presented = Buffer.from(hashToken(token), "hex");
  const stored = Buffer.from(storedHash, "hex");
  return (
    presented.length === stored.length && timingSafeEqual(presented, stored)
  );
}

export interface TokenRecord {
  readonly id: string;
  readonly project_id: ProjectId;
  readonly assignment_id: AssignmentId;
  readonly role_version: number;
  readonly allowed_tools: readonly ToolName[];
  readonly created_at: string;
  readonly revoked_at: string | null;
}

export interface IssueTokenInput {
  readonly project_id: ProjectId;
  readonly assignment_id: AssignmentId;
  readonly role: Pick<RoleReference, "role_version" | "allowed_tools">;
  /** Token material; generated when omitted. Never persisted in plain text. */
  readonly token?: string;
  readonly id?: string;
}

export interface IssuedToken {
  readonly token: string;
  readonly record: TokenRecord;
}

export function issueToken(
  db: DatabaseSync,
  input: IssueTokenInput,
  now: () => string = () => new Date().toISOString(),
): IssuedToken {
  const token = input.token ?? randomBytes(32).toString("base64url");
  const id = input.id ?? `tok_${randomBytes(12).toString("hex")}`;
  const created_at = now();
  db.prepare(
    "INSERT INTO tokens (id, project_id, assignment_id, role_version, allowed_tools, token_hash, created_at, revoked_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
  ).run(
    id,
    input.project_id,
    input.assignment_id,
    input.role.role_version,
    JSON.stringify(input.role.allowed_tools),
    hashToken(token),
    created_at,
  );
  return {
    token,
    record: {
      id,
      project_id: input.project_id,
      assignment_id: input.assignment_id,
      role_version: input.role.role_version,
      allowed_tools: input.role.allowed_tools,
      created_at,
      revoked_at: null,
    },
  };
}

/** All token rows of an assignment, oldest first (no hashes in the record). */
export function tokensForAssignment(
  db: DatabaseSync,
  project_id: ProjectId,
  assignment_id: AssignmentId,
): TokenRecord[] {
  return db
    .prepare(
      "SELECT id, project_id, assignment_id, role_version, allowed_tools, created_at, revoked_at " +
        "FROM tokens WHERE project_id = ? AND assignment_id = ? ORDER BY created_at, id",
    )
    .all(project_id, assignment_id)
    .map((row) => tokenRecord(row as Record<string, unknown>));
}

/** Current revocation work, without decoding historical tools or reading hashes. */
export function unrevokedTokensForProject(
  db: DatabaseSync,
  project_id: ProjectId,
): Pick<TokenRecord, "id" | "assignment_id">[] {
  return db
    .prepare(
      "SELECT id, assignment_id FROM tokens WHERE project_id = ? AND revoked_at IS NULL",
    )
    .all(project_id)
    .map((row) => ({
      id: String(row.id),
      assignment_id: String(row.assignment_id) as AssignmentId,
    }));
}

/** Look up a token by its hash; returns the record even when revoked. */
export function findTokenByHash(
  db: DatabaseSync,
  hash: string,
): TokenRecord | undefined {
  const row = db
    .prepare(
      "SELECT id, project_id, assignment_id, role_version, allowed_tools, created_at, revoked_at " +
        "FROM tokens WHERE token_hash = ?",
    )
    .get(hash) as Record<string, unknown> | undefined;
  return row === undefined ? undefined : tokenRecord(row);
}

function tokenRecord(row: Record<string, unknown>): TokenRecord {
  return {
    id: String(row.id),
    project_id: String(row.project_id),
    assignment_id: String(row.assignment_id) as AssignmentId,
    role_version: Number(row.role_version),
    allowed_tools: JSON.parse(String(row.allowed_tools)) as readonly ToolName[],
    created_at: String(row.created_at),
    revoked_at: row.revoked_at === null ? null : String(row.revoked_at),
  };
}

/**
 * Resolve a presented token to its record. A revoked token yields `undefined`,
 * exactly like an unknown one (§9.1 / M1.5 401 behaviour). The role id and
 * capabilities come from the assignment, not from the token row.
 */
export function verifyToken(
  db: DatabaseSync,
  token: string,
): TokenRecord | undefined {
  const record = findTokenByHash(db, hashToken(token));
  return record === undefined || record.revoked_at !== null
    ? undefined
    : record;
}

/** Mark a token revoked; revoking twice keeps the first timestamp. */
export function revokeToken(
  db: DatabaseSync,
  id: string,
  now: () => string = () => new Date().toISOString(),
): boolean {
  const result = db
    .prepare(
      "UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    )
    .run(now(), id);
  return Number(result.changes) > 0;
}
