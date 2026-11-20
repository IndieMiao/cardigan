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
import { assignment, event, latestSchemaVersion } from "./test-support.js";

test.each([24, 25])(
  "machine migration upgrades v%s atomically and preserves historical identities and aliases",
  checkMachineUpgrade,
);

function checkMachineUpgrade(previousVersion: number) {
  const dataDir = tempDir("cardigan-machine-upgrade-");
  const migrationsDir = join(dataDir, "old-migrations");
  mkdirSync(migrationsDir);
  for (const migration of listMigrations(defaultMigrationsDir).filter(
    (m) => m.version <= previousVersion,
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
    store.createProject({ id: "existing" });
    expect(store.database.prepare("SELECT * FROM machines").all()).toEqual([]);
    const noticeEvent = event({
      seq: 1,
      card_id: undefined,
      actor: { kind: "human" },
    });
    store.uow.run((tx) => {
      tx.machines.put("existing", {
        id: "local",
        label: "Existing fixture host",
        herdr_machine: "legacy-alias",
        os: "linux",
        arch: "x64",
        tags: ["fixture-toolchain"],
        status: "draining",
        max_assignments: 2,
        last_seen: "2026-01-01T00:00:00.000Z",
      });
      tx.events.append("a", noticeEvent);
    });
    store.database
      .prepare(`INSERT INTO notifications
      (project_id, id, event_id, recipient_kind, seq, kind, status, doc)
      VALUES ('a', 'fixture-notice', ?, 'needs_you', 1, 'comment', 'acked', '{}')`)
      .run(noticeEvent.id);
    const oldMachines = store.database.prepare("SELECT * FROM machines").all();
    const oldNotifications = store.database
      .prepare("SELECT * FROM notifications")
      .all();
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
    if (previousVersion === 25) {
      store.database.exec(
        `INSERT INTO ext_message_host_status VALUES (1, '{"fixture":"kept"}')`,
      );
      // Seed the historical schema directly; current outbox writers require v27.
      store.database
        .prepare(`INSERT INTO ext_message_outbox
        (project_id,item_kind,item_id,channel,event_id,status,next_attempt_at,updated_at)
        VALUES ('a','notice','fixture-notice','fixture-channel',?,'pending',?,?)`)
        .run(noticeEvent.id, noticeEvent.created_at, noticeEvent.created_at);
    }
    const oldOutbox =
      previousVersion === 25
        ? store.database.prepare("SELECT * FROM ext_message_outbox").all()
        : [];
    const expectPreservedData = (upgraded = false) => {
      expect(
        store.database
          .prepare("SELECT * FROM machines WHERE project_id = 'existing'")
          .all(),
      ).toEqual(oldMachines);
      expect(
        store.database.prepare("SELECT * FROM notifications").all(),
      ).toEqual(oldNotifications);
      expect(
        store.database.prepare("SELECT * FROM ext_message_outbox").all(),
      ).toEqual(
        upgraded
          ? oldOutbox.map((row) => ({ ...row, digest_id: null }))
          : oldOutbox,
      );
      expect(store.database.prepare("SELECT * FROM assignments").all()).toEqual(
        history,
      );
    };
    // Emulate the pre-registry schema, then fail after the first project's seed.
    store.database.exec(
      "DROP TRIGGER IF EXISTS snapshot_machines_insert; DROP TRIGGER IF EXISTS snapshot_machines_update; DROP TRIGGER IF EXISTS snapshot_machines_delete; CREATE TRIGGER fail_seed BEFORE INSERT ON machines WHEN NEW.project_id = 'z' BEGIN SELECT RAISE(ABORT, 'fixture seed failure'); END;",
    );
    expect(() => migrate(store.database)).toThrow("fixture seed failure");
    // Earlier migrations commit independently; only the machine upgrade rolls back.
    expect(store.schemaVersion()).toBe(25);
    expect(store.database.prepare("SELECT * FROM machines").all()).toEqual(
      oldMachines,
    );
    expectPreservedData();
    expect(
      store.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE name = 'assignment_machine_immutable'",
        )
        .get(),
    ).toBeUndefined();
    store.database.exec("DROP TRIGGER fail_seed");
    store.close();
    store = Store.open({ dataDir });
    expect(
      store.database
        .prepare(
          "SELECT version, name FROM schema_version WHERE version >= 25 ORDER BY version",
        )
        .all(),
    ).toEqual([
      { version: 25, name: "ext_message" },
      { version: 26, name: "machine_registry" },
      { version: 27, name: "ext_message_digest" },
      { version: 28, name: "check_handoff" },
      { version: 29, name: "context_samples" },
      { version: 30, name: "upstream_probe_samples" },
      { version: 31, name: "bell_run_history" },
      { version: 32, name: "check_recovery" },
      { version: 33, name: "check_log_debits" },
      { version: 34, name: "precheck_recovery" },
      { version: 35, name: "card_review_lookup" },
      { version: 36, name: "deployment_wait" },
      { version: 37, name: "merge_batch_checks" },
      { version: 38, name: "notification_status" },
      { version: 39, name: "ui_template" },
      { version: 40, name: "machine_capabilities" },
      { version: 41, name: "precheck_head_proofs" },
      { version: 42, name: "bell_continuation" },
      { version: 43, name: "review_wake_boundary" },
      { version: 44, name: "launch_generations" },
      { version: 45, name: "accepted_browser_path" },
    ]);
    expect(
      store.database.prepare("SELECT * FROM ext_message_host_status").all(),
    ).toEqual(
      previousVersion === 25 ? [{ id: 1, doc: '{"fixture":"kept"}' }] : [],
    );
    expect(store.uow.read((tx) => tx.machines.list("a"))).toMatchObject([
      { id: "local" },
    ]);
    expect(store.uow.read((tx) => tx.machines.list("z"))).toHaveLength(1);
    expectPreservedData(true);
    store.uow.run((tx) => {
      const local = tx.machines.get("a", "local");
      if (!local) throw new Error("missing local");
      tx.machines.put("a", { ...local, herdr_machine: "legacy-alias" });
    });
    expect(store.migrate()).toEqual([]);
    expectPreservedData(true);
    store.createProject({ id: "new" });
    expect(store.uow.read((tx) => tx.machines.list("new"))).toMatchObject([
      { id: "local" },
    ]);
    expect(
      store.uow.read((tx) => tx.machines.get("a", "local"))?.herdr_machine,
    ).toBe("legacy-alias");
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

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
