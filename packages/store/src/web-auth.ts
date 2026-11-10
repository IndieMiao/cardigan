import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { activeOwner, type MemberId } from "@cardigan/domain";
import { createMemberRepository } from "./members.js";

/**
 * The human's Workbench password and its sessions (§14, M5 plan §3.2).
 *
 * The password is hashed with scrypt and a per-password salt using
 * `node:crypto` only: no new dependency, and the parameters travel with the
 * hash so a database written by an older build still verifies.
 *
 * Session tokens are random 256-bit values; the database only keeps their
 * sha256, so a leaked database gives no usable cookie. Changing the password
 * revokes every session, which is what "改密码立即失效" means.
 */

/** Shortest accepted password (M5 plan §0). */
export const MIN_WEB_PASSWORD_LENGTH = 12;
/** Session lifetime: 7 days by default (M5 plan §0). */
export const DEFAULT_WEB_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** scrypt cost parameters. N is a power of two; memory is about 128*N*r bytes. */
const SCRYPT = { N: 16_384, r: 8, p: 1, keylen: 64 } as const;
const HASH_PREFIX = "scrypt";

export interface WebCredential {
  readonly password_hash: string;
  readonly updated_at: string;
}

export interface WebSession {
  readonly member_id: MemberId | null;
  readonly created_at: string;
  readonly last_seen_at: string;
  readonly expires_at: string;
  readonly revoked_at: string | null;
}

export interface IssuedWebSession {
  /** Cookie value; never stored. */
  readonly token: string;
  readonly session: WebSession;
}

/** `last_seen_at` is only refreshed this often, to keep reads off the write lock. */
const TOUCH_INTERVAL_MS = 60_000;

function reject(message: string): never {
  throw new Error(message);
}

/** Hash a password; the returned string carries its own scrypt parameters. */
export function hashWebPassword(password: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(password.normalize("NFKC"), salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    HASH_PREFIX,
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

/**
 * Constant-time check of a presented password against a stored hash.
 *
 * A malformed hash answers `false` instead of throwing: a corrupted row must
 * read as "no password works", not as a crashed login endpoint.
 */
export function verifyWebPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== HASH_PREFIX) {
    return false;
  }
  const [, nText, rText, pText, saltText, hashText] = parts;
  const N = Number(nText);
  const r = Number(rText);
  const p = Number(pText);
  if (
    !Number.isInteger(N) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    N < 2 ||
    N > 1_048_576 ||
    r < 1 ||
    p < 1 ||
    saltText === undefined ||
    hashText === undefined
  ) {
    return false;
  }
  const salt = Buffer.from(saltText, "base64url");
  const expected = Buffer.from(hashText, "base64url");
  if (salt.length === 0 || expected.length === 0) {
    return false;
  }
  let derived: Buffer;
  try {
    derived = scryptSync(password.normalize("NFKC"), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 256 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return (
    derived.length === expected.length && timingSafeEqual(derived, expected)
  );
}

/** Validate and store a new password; every existing session is revoked. */
export function setWebPassword(
  db: DatabaseSync,
  password: string,
  now: () => string = () => new Date().toISOString(),
): WebCredential {
  if (Array.from(password).length < MIN_WEB_PASSWORD_LENGTH) {
    reject(
      `web password must be at least ${MIN_WEB_PASSWORD_LENGTH} characters`,
    );
  }
  const record: WebCredential = {
    password_hash: hashWebPassword(password),
    updated_at: now(),
  };
  db.prepare(
    "INSERT INTO web_credential (id, password_hash, updated_at) VALUES (1, ?, ?) " +
      "ON CONFLICT (id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at",
  ).run(record.password_hash, record.updated_at);
  revokeAllWebSessions(db, now);
  return record;
}

export function webCredential(db: DatabaseSync): WebCredential | undefined {
  const row = db
    .prepare(
      "SELECT password_hash, updated_at FROM web_credential WHERE id = 1",
    )
    .get() as { password_hash: string; updated_at: string } | undefined;
  return row === undefined
    ? undefined
    : {
        password_hash: String(row.password_hash),
        updated_at: String(row.updated_at),
      };
}

/** True when `cardigan web set-password` has run. */
export function webPasswordConfigured(db: DatabaseSync): boolean {
  return webCredential(db) !== undefined;
}

/** Check a login attempt; an unset password never matches. */
export function verifyWebLogin(db: DatabaseSync, password: string): boolean {
  const stored = webCredential(db);
  return stored === undefined
    ? false
    : verifyWebPassword(password, stored.password_hash);
}

/** Only the sha256 of a session token is stored. */
export function hashWebSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function createWebSession(
  db: DatabaseSync,
  options: {
    readonly now?: () => string;
    readonly ttlMs?: number;
  } = {},
): IssuedWebSession {
  const now = options.now ?? (() => new Date().toISOString());
  const ttlMs = options.ttlMs ?? DEFAULT_WEB_SESSION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    reject("session lifetime must be a positive number of milliseconds");
  }
  const token = randomBytes(32).toString("base64url");
  const created_at = now();
  const session: WebSession = {
    member_id:
      activeOwner(createMemberRepository(db, "read").list())?.id ?? null,
    created_at,
    last_seen_at: created_at,
    expires_at: new Date(Date.parse(created_at) + ttlMs).toISOString(),
    revoked_at: null,
  };
  db.prepare(
    "INSERT INTO web_sessions (id_hash, created_at, last_seen_at, expires_at, revoked_at, member_id) " +
      "VALUES (?, ?, ?, ?, NULL, ?)",
  ).run(
    hashWebSessionToken(token),
    session.created_at,
    session.last_seen_at,
    session.expires_at,
    session.member_id,
  );
  return { token, session };
}

/**
 * Resolve a cookie value to a live session. Revoked, expired and unknown
 * tokens all answer `undefined`, so the caller cannot tell them apart.
 */
export function findWebSession(
  db: DatabaseSync,
  token: string,
  now: () => string = () => new Date().toISOString(),
): WebSession | undefined {
  if (token.length === 0) {
    return undefined;
  }
  const id_hash = hashWebSessionToken(token);
  const row = db
    .prepare(
      "SELECT created_at, last_seen_at, expires_at, revoked_at, member_id FROM web_sessions WHERE id_hash = ?",
    )
    .get(id_hash) as
    | {
        member_id: MemberId | null;
        created_at: string;
        last_seen_at: string;
        expires_at: string;
        revoked_at: string | null;
      }
    | undefined;
  if (row === undefined) {
    return undefined;
  }
  const session: WebSession = {
    member_id: row.member_id,
    created_at: String(row.created_at),
    last_seen_at: String(row.last_seen_at),
    expires_at: String(row.expires_at),
    revoked_at: row.revoked_at === null ? null : String(row.revoked_at),
  };
  const at = now();
  if (
    session.revoked_at !== null ||
    Date.parse(session.expires_at) <= Date.parse(at)
  ) {
    return undefined;
  }
  let member_id = session.member_id;
  if (member_id === null) {
    member_id =
      activeOwner(createMemberRepository(db, "read").list())?.id ?? null;
    if (member_id !== null) {
      db.prepare(
        "UPDATE web_sessions SET member_id = ? WHERE id_hash = ? AND member_id IS NULL",
      ).run(member_id, id_hash);
    }
  }
  const staleBefore = new Date(
    Date.parse(at) - TOUCH_INTERVAL_MS,
  ).toISOString();
  if (session.last_seen_at < staleBefore) {
    db.prepare(
      "UPDATE web_sessions SET last_seen_at = ? WHERE id_hash = ? AND last_seen_at < ?",
    ).run(at, id_hash, staleBefore);
  }
  return { ...session, member_id };
}

/** Log out one session; a second call is a no-op. */
export function revokeWebSession(
  db: DatabaseSync,
  token: string,
  now: () => string = () => new Date().toISOString(),
): boolean {
  const result = db
    .prepare(
      "UPDATE web_sessions SET revoked_at = ? WHERE id_hash = ? AND revoked_at IS NULL",
    )
    .run(now(), hashWebSessionToken(token));
  return Number(result.changes) > 0;
}

/** Used by a password change: no cookie survives it. */
export function revokeAllWebSessions(
  db: DatabaseSync,
  now: () => string = () => new Date().toISOString(),
): number {
  const result = db
    .prepare("UPDATE web_sessions SET revoked_at = ? WHERE revoked_at IS NULL")
    .run(now());
  return Number(result.changes);
}

/** Housekeeping for the execution view and for tests. */
export function countWebSessions(db: DatabaseSync): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM web_sessions WHERE revoked_at IS NULL",
    )
    .get() as { count: number };
  return Number(row.count);
}
