import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  defaultMigrationsDir,
  listMigrations,
  migrate,
  Store,
} from "./index.js";
import { assignment, latestSchemaVersion } from "./test-support.js";

test("machine migration backfills local atomically and preserves historical identities and aliases", () => {
  const dataDir = tempDir("cardigan-machine-upgrade-");
  const migrationsDir = join(dataDir, "old-migrations");
  mkdirSync(migrationsDir);
  for (const migration of listMigrations(defaultMigrationsDir).filter(
    (m) => m.version < 25,
  ))
    writeFileSync(
      join(
        migrationsDir,
        `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
      ),
      migration.sql,
    );
  let store = Store.open({ dataDir, migrationsDir });
  try {
    store.createProject({ id: "a" });
    store.createProject({ id: "z" });
    store.uow.run((tx) =>
      tx.assignments.put(
        "a",
        assignment({
          runtime_ref: {
            machine_id: "local",
            runtime_machine: "legacy-alias",
            agent_name: "fixture-agent",
            agent_session_id: "session",
            terminal_ref: "terminal",
          },
        }),
      ),
    );
    const history = store.database.prepare("SELECT * FROM assignments").all();
    // Emulate the original v24 schema, then fail after the first project's seed.
    store.database.exec(
      "DROP TRIGGER IF EXISTS snapshot_machines_insert; DROP TRIGGER IF EXISTS snapshot_machines_update; DROP TRIGGER IF EXISTS snapshot_machines_delete; CREATE TRIGGER fail_seed BEFORE INSERT ON machines WHEN NEW.project_id = 'z' BEGIN SELECT RAISE(ABORT, 'fixture seed failure'); END;",
    );
    expect(() => migrate(store.database)).toThrow("fixture seed failure");
    expect(store.schemaVersion()).toBe(24);
    expect(store.database.prepare("SELECT * FROM machines").all()).toEqual([]);
    expect(
      store.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'assignment_machine_immutable'",
        )
        .get(),
    ).toBeUndefined();
    expect(store.database.prepare("SELECT * FROM assignments").all()).toEqual(
      history,
    );
    store.database.exec("DROP TRIGGER fail_seed");
    store.close();
    store = Store.open({ dataDir });
    expect(store.uow.read((tx) => tx.machines.list("a"))).toMatchObject([
      { id: "local" },
    ]);
    expect(store.uow.read((tx) => tx.machines.list("z"))).toHaveLength(1);
    expect(store.database.prepare("SELECT * FROM assignments").all()).toEqual(
      history,
    );
    store.uow.run((tx) => {
      const local = tx.machines.get("a", "local");
      if (!local) throw new Error("missing local");
      tx.machines.put("a", { ...local, herdr_machine: "legacy-alias" });
    });
    expect(store.migrate()).toEqual([]);
    expect(
      store.uow.read((tx) => tx.machines.get("a", "local"))?.herdr_machine,
    ).toBe("legacy-alias");
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("migrates an empty database and creates every M1 table", () => {
  const dataDir = tempDir("cardigan-migrate-");
  const store = Store.open({ dataDir });
  try {
    expect(existsSync(join(dataDir, "cardigan.db"))).toBe(true);
    expect(store.schemaVersion()).toBe(latestSchemaVersion());

    const tables = store.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name));
    for (const table of [
      "cards",
      "work_items",
      "assignments",
      "runs",
      "timeline",
      "deliveries",
      "reviews",
      "decisions",
      "human_actions",
      "attachments",
      "roles",
      "machines",
      "events",
      "event_counters",
      "id_counters",
      "cursors",
      "idempotency",
      "tokens",
      "projects",
      // M3.3: the router inbox and its cursor.
      "notifications",
      "router_cursors",
      "bell_attempts",
      "merge_check_capacity",
      "schema_version",
    ]) {
      expect(tables, table).toContain(table);
    }
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("re-running migrations is a no-op and keeps data", () => {
  const dataDir = tempDir("cardigan-migrate-");
  const store = Store.open({ dataDir });
  try {
    store.database
      .prepare(
        "INSERT INTO id_counters (project_id, kind, value) VALUES (?, ?, ?)",
      )
      .run("p", "card", 7);

    expect(store.migrate()).toEqual([]);
    expect(store.schemaVersion()).toBe(latestSchemaVersion());
    const row = store.database
      .prepare(
        "SELECT value FROM id_counters WHERE project_id = ? AND kind = ?",
      )
      .get("p", "card");
    expect(Number(row?.value)).toBe(7);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("enables WAL and enforces foreign keys", () => {
  const dataDir = tempDir("cardigan-migrate-");
  const store = Store.open({ dataDir });
  try {
    expect(
      String(store.database.prepare("PRAGMA journal_mode").get()?.journal_mode),
    ).toBe("wal");
    expect(
      Number(store.database.prepare("PRAGMA foreign_keys").get()?.foreign_keys),
    ).toBe(1);

    // events.card_id references cards, so an unknown card is rejected.
    expect(() =>
      store.database
        .prepare(
          "INSERT INTO events (project_id, id, card_id, stream, seq, type, doc) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("p", "01J0000000000000000000000A", "C-404", "C-404", 1, "x", "{}"),
    ).toThrow(/FOREIGN KEY/i);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a failing migration leaves nothing behind and is not recorded", () => {
  const dataDir = tempDir("cardigan-migrate-");
  const migrationsDir = tempDir("cardigan-migrations-");
  const emptyMigrationsDir = tempDir("cardigan-empty-migrations-");
  writeFileSync(
    join(migrationsDir, "0001_broken.sql"),
    "CREATE TABLE half_done (id TEXT);\nSELECT * FROM table_that_does_not_exist;\n",
  );
  try {
    expect(() => Store.open({ dataDir, migrationsDir })).toThrow(
      /table_that_does_not_exist/,
    );

    // Reopen the same file: the half-applied migration left no trace.
    const store = Store.open({
      dataDir,
      migrationsDir: emptyMigrationsDir,
    });
    try {
      const tables = store.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name));
      expect(tables).toContain("schema_version");
      expect(tables).not.toContain("half_done");
      expect(store.schemaVersion()).toBe(
        latestSchemaVersion(emptyMigrationsDir),
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(migrationsDir, { recursive: true, force: true });
    rmSync(emptyMigrationsDir, { recursive: true, force: true });
  }
});

test("listMigrations ignores other files and sorts by version", () => {
  const dir = tempDir("cardigan-migrations-");
  writeFileSync(join(dir, "0002_second.sql"), "SELECT 2;");
  writeFileSync(join(dir, "0001_first.sql"), "SELECT 1;");
  writeFileSync(join(dir, "notes.txt"), "ignore me");
  try {
    expect(listMigrations(dir).map((m) => [m.version, m.name])).toEqual([
      [1, "first"],
      [2, "second"],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply later migrations once, without re-running earlier ones", () => {
  const dataDir = tempDir("cardigan-migrate-");
  const migrationsDir = tempDir("cardigan-migrations-");
  writeFileSync(
    join(migrationsDir, "0001_initial.sql"),
    "CREATE TABLE a (id TEXT);",
  );
  writeFileSync(
    join(migrationsDir, "0002_more.sql"),
    "CREATE TABLE b (id TEXT);",
  );

  const store = Store.open({ dataDir, migrationsDir });
  try {
    expect(store.schemaVersion()).toBe(latestSchemaVersion(migrationsDir));
    expect(store.migrate()).toEqual([]);

    writeFileSync(
      join(migrationsDir, "0003_later.sql"),
      "CREATE TABLE c (id TEXT);",
    );
    expect(store.migrate()).toEqual([{ version: 3, name: "later" }]);
    expect(migrate(store.database, migrationsDir)).toEqual([]);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(migrationsDir, { recursive: true, force: true });
  }
});
