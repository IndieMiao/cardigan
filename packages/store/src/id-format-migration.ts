import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { normalizeLegacyId } from "@cardigan/domain";

/** Schema version of `0018_readable_id_format.sql`. */
export const ID_FORMAT_MIGRATION_VERSION = 18;

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

function rewriteJson(value: unknown): { value: unknown; changed: boolean } {
  if (typeof value === "string") {
    const next = normalizeLegacyId(value);
    return next === undefined
      ? { value, changed: false }
      : { value: next, changed: true };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const result = rewriteJson(item);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? items : value, changed };
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const entries = Object.entries(value).map(([key, item]) => {
      const nextKey = normalizeLegacyId(key) ?? key;
      const result = rewriteJson(item);
      changed ||= result.changed || nextKey !== key;
      return [nextKey, result.value] as const;
    });
    return { value: changed ? Object.fromEntries(entries) : value, changed };
  }
  return { value, changed: false };
}

/**
 * The stored text with every whole-value legacy id (`q(n)` / `h(n)`) replaced:
 * a column that is exactly an id, or a string value / key inside a JSON
 * document. Free text such as comment bodies is never rewritten, so history
 * reads as written. Returns `undefined` when nothing changes (idempotent).
 */
export function rewriteLegacyIds(text: string): string | undefined {
  const whole = normalizeLegacyId(text);
  if (whole !== undefined) return whole;
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
        const next = rewriteLegacyIds(value);
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
  if (
    !migrations.some(
      (m) =>
        m.version === ID_FORMAT_MIGRATION_VERSION &&
        m.name === "readable_id_format",
    )
  )
    return undefined;
  const hasVersions = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
    )
    .get();
  if (!hasVersions) return undefined;
  const applied = db
    .prepare("SELECT 1 FROM schema_version WHERE version = ?")
    .get(ID_FORMAT_MIGRATION_VERSION);
  if (applied) return undefined;
  const stamp = now.replace(/[^0-9A-Za-z]/gu, "");
  let backup = `${dbPath}.pre-0018-${stamp}.bak`;
  for (let n = 1; existsSync(backup); n += 1)
    backup = `${dbPath}.pre-0018-${stamp}-${n}.bak`;
  db.prepare("VACUUM INTO ?").run(backup);
  return backup;
}
