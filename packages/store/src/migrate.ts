import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/** Directory shipped next to the compiled package: `packages/store/migrations`. */
export const defaultMigrationsDir = fileURLToPath(
  new URL("../migrations/", import.meta.url),
);

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
}

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/**
 * Apply every migration that `schema_version` does not list yet, in version
 * order, each in its own transaction. Running it twice is a no-op.
 */
export function migrate(
  db: DatabaseSync,
  migrationsDir: string = defaultMigrationsDir,
  now: () => string = () => new Date().toISOString(),
): AppliedMigration[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_version (" +
      "version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(
    db
      .prepare("SELECT version FROM schema_version")
      .all()
      .map((row) => Number(row.version)),
  );

  const newlyApplied: AppliedMigration[] = [];
  for (const migration of listMigrations(migrationsDir)) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, now());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    newlyApplied.push({ version: migration.version, name: migration.name });
  }
  return newlyApplied;
}

/** Migration files on disk, sorted by version; anything else is ignored. */
export function listMigrations(migrationsDir: string): MigrationFile[] {
  const migrations: MigrationFile[] = [];
  for (const entry of readdirSync(migrationsDir).sort()) {
    const match = MIGRATION_FILE.exec(entry);
    if (match === null) {
      continue;
    }
    migrations.push({
      version: Number(match[1]),
      name: match[2] ?? entry,
      sql: readFileSync(join(migrationsDir, entry), "utf8"),
    });
  }
  return migrations;
}
