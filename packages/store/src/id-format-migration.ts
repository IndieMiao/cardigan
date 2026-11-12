import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { normalizeLegacyId } from "@cardigan/domain";

/**
 * Name of the id-format migration (`NNNN_readable_id_format.sql`, currently
 * 0018). Matched by name, so renumbering the file needs no code change.
 */
export const ID_FORMAT_MIGRATION_NAME = "readable_id_format";

/**
 * Tables never rewritten: migration bookkeeping, snapshot bookkeeping that the
 * triggers refresh from the entity updates below, and append-only template
 * history, which never holds decision or action ids.
 */
const SKIPPED = new Set([
  "schema_version",
  "command_versions",
  "command_rows",
  "assignment_activity",
  "card_templates",
]);

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/**
 * JSON fields that hold decision / human action references (C-132). Only
 * these are rewritten; any other field — comment bodies, `raw_quote`, option
 * keys, idempotency keys — keeps its exact text even when it reads `q(95)`.
 */
const REFERENCE_FIELD =
  /^(?:id|[a-z_]+_ids?|amends|superseded_by|superseded|basis|ref|decisions|open_decisions|human_actions)$/u;
/** Columns that hold a reference as their whole value. */
const REFERENCE_COLUMN = /^(?:id|[a-z_]+_id)$/u;

const rewriteId = (value: unknown): unknown =>
  typeof value === "string" ? (normalizeLegacyId(value) ?? value) : value;

function rewriteJson(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const result = rewriteJson(item);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? items : value, changed };
  }
  if (value === null || typeof value !== "object") {
    return { value, changed: false };
  }
  const record = value as Record<string, unknown>;
  // `key` is the decision / action's own number only when it mirrors `id`.
  const legacyKey =
    typeof record.id === "string" &&
    record.key === record.id &&
    normalizeLegacyId(record.id) !== undefined;
  let changed = false;
  const entries = Object.entries(record).map(([field, item]) => {
    let next: unknown;
    if (REFERENCE_FIELD.test(field) || (field === "key" && legacyKey)) {
      next = Array.isArray(item)
        ? item.map((element) =>
            typeof element === "string"
              ? rewriteId(element)
              : rewriteJson(element).value,
          )
        : typeof item === "string"
          ? rewriteId(item)
          : rewriteJson(item).value;
    } else next = rewriteJson(item).value;
    changed ||= JSON.stringify(next) !== JSON.stringify(item);
    return [field, next] as const;
  });
  return { value: changed ? Object.fromEntries(entries) : value, changed };
}

/**
 * The stored text of `column` with legacy ids (`q(n)` / `h(n)`) in reference
 * positions replaced: an id column whose whole value is a legacy id, or a
 * reference field inside a JSON document. Free text is never rewritten, so
 * history reads as written. Returns `undefined` when nothing changes.
 */
export function rewriteLegacyIds(
  text: string,
  column = "doc",
): string | undefined {
  if (REFERENCE_COLUMN.test(column)) return normalizeLegacyId(text);
  const first = text.trimStart()[0];
  if (first !== "{" && first !== "[") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = rewriteJson(parsed);
  return result.changed ? JSON.stringify(result.value) : undefined;
}

/** `Q-n` / `H-n` → `q(n)` / `h(n)`: how a pre-C-132 client spelled the id. */
const legacySpelling = (value: string): string | undefined => {
  const match = /^([QH])-([1-9][0-9]*)$/u.exec(value);
  return match ? `${match[1] === "Q" ? "q" : "h"}(${match[2]})` : undefined;
};

/**
 * The request as a pre-C-132 server stored it: parseId returned `q(n)` /
 * `h(n)` unchanged, so every id the client sent was in the legacy spelling.
 * Used only to match idempotency records written before migration 0018.
 */
export function legacyRequest(value: unknown): unknown {
  if (typeof value === "string") return legacySpelling(value) ?? value;
  if (Array.isArray(value)) return value.map(legacyRequest);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, legacyRequest(v)]),
  );
}

/**
 * C-132: rewrite stored `q(n)` / `h(n)` to `Q-n` / `H-n` in every table. Runs
 * inside the migration transaction; ID counters are untouched, so new numbers
 * continue the old sequence. Safe to run again: new-format values never match.
 * Returns the number of rows rewritten.
 */
export function migrateReadableIdFormat(db: DatabaseSync): number {
  let rewritten = 0;
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name))
    .filter((name) => !SKIPPED.has(name));
  for (const table of tables) {
    const columns = db
      .prepare(`PRAGMA table_info(${quote(table)})`)
      .all()
      .filter((column) => /TEXT|^$/iu.test(String(column.type)))
      .map((column) => String(column.name));
    if (columns.length === 0) continue;
    const candidates = columns
      .map(
        (c) =>
          `(typeof(${quote(c)}) = 'text' AND (instr(${quote(c)}, 'q(') > 0 OR instr(${quote(c)}, 'h(') > 0))`,
      )
      .join(" OR ");
    const rows = db
      .prepare(
        `SELECT rowid AS "__rowid", ${columns.map(quote).join(", ")} FROM ${quote(table)} WHERE ${candidates}`,
      )
      .all();
    for (const row of rows) {
      const changes = columns.flatMap((column) => {
        const value = row[column];
        if (typeof value !== "string") return [];
        const next = rewriteLegacyIds(value, column);
        return next === undefined ? [] : [[column, next] as const];
      });
      if (changes.length === 0) continue;
      db.prepare(
        `UPDATE ${quote(table)} SET ${changes.map(([c]) => `${quote(c)} = ?`).join(", ")} WHERE rowid = ?`,
      ).run(...changes.map(([, v]) => v), Number(row.__rowid));
      rewritten += 1;
    }
  }
  return rewritten;
}

/**
 * Before the id-format rewrite touches an existing database file, copy it with
 * `VACUUM INTO` next to the original. Returns the backup path, or `undefined`
 * when there is nothing to back up (in-memory, never migrated, already applied).
 *
 * Rollback: stop the server, replace the database file with the backup and
 * delete the stale `-wal` / `-shm` files; then run the previous build.
 */
export function backupBeforeIdFormatMigration(
  db: DatabaseSync,
  dbPath: string,
  now: string,
  /** The migrations about to be applied (`listMigrations`). */
  migrations: readonly { readonly version: number; readonly name: string }[],
): string | undefined {
  if (dbPath === "" || dbPath === ":memory:" || dbPath.startsWith("file:"))
    return undefined;
  const migration = migrations.find((m) => m.name === ID_FORMAT_MIGRATION_NAME);
  if (!migration) return undefined;
  const hasVersions = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
    )
    .get();
  if (!hasVersions) return undefined;
  const applied = db
    .prepare("SELECT 1 FROM schema_version WHERE name = ?")
    .get(ID_FORMAT_MIGRATION_NAME);
  if (applied) return undefined;
  const stamp = now.replace(/[^0-9A-Za-z]/gu, "");
  const tag = String(migration.version).padStart(4, "0");
  let backup = `${dbPath}.pre-${tag}-${stamp}.bak`;
  for (let n = 1; existsSync(backup); n += 1)
    backup = `${dbPath}.pre-${tag}-${stamp}-${n}.bak`;
  db.prepare("VACUUM INTO ?").run(backup);
  return backup;
}
