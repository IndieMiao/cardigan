import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { defaultMigrationsDir, listMigrations, migrate } from "./migrate.js";

test("fresh databases install both inbox tracking and Workbench indexes with unique versions", () => {
  const migrations = listMigrations(defaultMigrationsDir);
  expect(new Set(migrations.map((m) => m.version)).size).toBe(
    migrations.length,
  );
  const db = new DatabaseSync(":memory:");
  try {
    expect(migrate(db)).toEqual(
      expect.arrayContaining([
        { version: 23, name: "inbox_change_feed" },
        { version: 24, name: "workbench_pagination" },
      ]),
    );
    const objects = db
      .prepare("SELECT name FROM sqlite_schema")
      .all()
      .map((row) => row.name);
    for (const table of ["notifications", "bell_attempts"])
      for (const operation of ["insert", "update", "delete"])
        expect(objects).toContain(`change_feed_${table}_${operation}`);
    expect(objects).toEqual(
      expect.arrayContaining([
        "events_by_card_time",
        "events_by_decision",
        "events_by_attachment",
        "events_by_context_generation",
      ]),
    );
    expect(migrate(db)).toEqual([]);
  } finally {
    db.close();
  }
});

test.each(["pagination-only", "complete"] as const)(
  "Workbench indexes upgrade populated inbox-feed v23 data, preserve writes and repeat safely (%s)",
  checkWorkbenchUpgrade,
);

function checkWorkbenchUpgrade(scope: "pagination-only" | "complete") {
  const dir = mkdtempSync(join(tmpdir(), "cg-page-migration-"));
  const db = new DatabaseSync(join(dir, "source.db"));
  db.exec("PRAGMA journal_mode = WAL");
  try {
    for (const migration of listMigrations(defaultMigrationsDir).filter(
      (m) => m.version < 24,
    ))
      writeFileSync(
        join(
          dir,
          `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
        ),
        migration.sql,
      );
    migrate(db, dir);
    const card = JSON.stringify({ id: "C-1", status: "todo" });
    db.prepare("INSERT INTO cards VALUES (?, ?, ?)").run("p", "C-1", card);
    const event = db.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)");
    event.run(
      "p",
      "e1",
      "C-1",
      "C-1",
      1,
      "comment_posted",
      JSON.stringify({ created_at: "2026-01-01" }),
    );
    db.exec(`INSERT INTO notifications
      (project_id, id, event_id, recipient_kind, seq, kind, status, doc)
      VALUES ('p', 'n1', 'e1', 'needs_you', 1, 'comment', 'pending', '{}')`);
    const inboxVersion = () =>
      Number(
        db
          .prepare(
            "SELECT version FROM command_versions WHERE project_id = 'p' AND collection = 'notifications'",
          )
          .get()?.version,
      );
    const beforeVersion = inboxVersion();
    expect(beforeVersion).toBeGreaterThan(0);
    const backupPath = join(dir, "before-upgrade.db");
    db.prepare("VACUUM INTO ?").run(backupPath);
    chmodSync(backupPath, 0o600);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      expect(
        backup.prepare("SELECT MAX(version) AS n FROM schema_version").get()?.n,
      ).toBe(23);
      expect(
        backup
          .prepare("SELECT id FROM events")
          .all()
          .map((r) => r.id),
      ).toEqual(["e1"]);
    } finally {
      backup.close();
    }
    // Isolate the v24 contract while also exercising the real full upgrade path.
    const paginationFile = "0024_workbench_pagination.sql";
    writeFileSync(
      join(dir, paginationFile),
      readFileSync(join(defaultMigrationsDir, paginationFile), "utf8"),
    );
    const targetDir = scope === "pagination-only" ? dir : defaultMigrationsDir;
    expect(migrate(db, targetDir)).toEqual(
      scope === "pagination-only"
        ? [{ version: 24, name: "workbench_pagination" }]
        : listMigrations(defaultMigrationsDir)
            .filter((migration) => migration.version >= 24)
            .map(({ version, name }) => ({ version, name })),
    );
    expect(migrate(db, targetDir)).toEqual([]);
    expect(inboxVersion()).toBe(beforeVersion);
    db.exec(
      "UPDATE notifications SET status = 'acked' WHERE project_id = 'p' AND id = 'n1'",
    );
    expect(inboxVersion()).toBeGreaterThan(beforeVersion);
    expect(
      db
        .prepare(
          "SELECT version FROM command_rows WHERE project_id = 'p' AND collection = 'notifications' AND entity_key = '[\"n1\"]'",
        )
        .get()?.version,
    ).toBe(inboxVersion());
    expect(db.prepare("SELECT doc FROM cards").get()?.doc).toBe(card);
    const sql =
      "SELECT id FROM events WHERE project_id = ? ORDER BY json_extract(doc, '$.created_at') DESC, id DESC LIMIT 1";
    expect(
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all("p")
        .map((r) => r.detail)
        .join(" "),
    ).toContain("events_by_time");
    expect(db.prepare(sql).get("p")?.id).toBe("e1");
    event.run(
      "p",
      "e2",
      "C-1",
      "C-1",
      2,
      "comment_posted",
      JSON.stringify({ created_at: "2026-01-02" }),
    );
    expect(db.prepare(sql).get("p")?.id).toBe("e2");
    event.run(
      "p",
      "generation",
      "C-1",
      "C-1",
      3,
      "session_replaced",
      JSON.stringify({
        payload: { assignment_id: "A-1" },
        created_at: "2026-01-03",
      }),
    );
    const generationSql =
      "SELECT id FROM events WHERE project_id = ? AND json_extract(doc, '$.payload.assignment_id') = ? AND type IN ('session_replaced', 'standing_session_restarted', 'assignment_resumed', 'host_ops_action_finished') ORDER BY json_extract(doc, '$.created_at') DESC LIMIT 1";
    expect(
      db
        .prepare(`EXPLAIN QUERY PLAN ${generationSql}`)
        .all("p", "A-1")
        .map((r) => r.detail)
        .join(" "),
    ).toContain("events_by_context_generation (project_id=? AND <expr>=?)");
    expect(db.prepare(generationSql).get("p", "A-1")?.id).toBe("generation");
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe(
      "ok",
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a failure after creating pagination indexes rolls back every index and version", () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-page-rollback-"));
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of listMigrations(defaultMigrationsDir).filter(
      (m) => m.version < 24,
    ))
      writeFileSync(
        join(
          dir,
          `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`,
        ),
        migration.sql,
      );
    migrate(db, dir);
    const sql = readFileSync(
      join(defaultMigrationsDir, "0024_workbench_pagination.sql"),
      "utf8",
    );
    writeFileSync(
      join(dir, "0024_workbench_pagination.sql"),
      `${sql}\nSELECT * FROM missing_pagination_table;`,
    );
    expect(() => migrate(db, dir)).toThrow(/missing_pagination_table/u);
    expect(
      db.prepare("SELECT MAX(version) AS n FROM schema_version").get()?.n,
    ).toBe(23);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name IN ('events_by_time','runs_by_number','timeline_by_action','events_by_context_generation')",
        )
        .all(),
    ).toEqual([]);
    writeFileSync(join(dir, "0024_workbench_pagination.sql"), sql);
    expect(migrate(db, dir)).toEqual([
      { version: 24, name: "workbench_pagination" },
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
