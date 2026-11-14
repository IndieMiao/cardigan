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

test("Workbench indexes upgrade populated v22 data, preserve writes and repeat safely", () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-page-migration-"));
  const db = new DatabaseSync(join(dir, "source.db"));
  db.exec("PRAGMA journal_mode = WAL");
  try {
    for (const migration of listMigrations(defaultMigrationsDir).filter(
      (m) => m.version < 23,
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
    const backupPath = join(dir, "before-upgrade.db");
    db.prepare("VACUUM INTO ?").run(backupPath);
    chmodSync(backupPath, 0o600);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      expect(
        backup.prepare("SELECT MAX(version) AS n FROM schema_version").get()?.n,
      ).toBe(22);
      expect(
        backup
          .prepare("SELECT id FROM events")
          .all()
          .map((r) => r.id),
      ).toEqual(["e1"]);
    } finally {
      backup.close();
    }
    expect(migrate(db)).toEqual([
      { version: 23, name: "workbench_pagination" },
    ]);
    expect(migrate(db)).toEqual([]);
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
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe(
      "ok",
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failure after creating pagination indexes rolls back every index and version", () => {
  const dir = mkdtempSync(join(tmpdir(), "cg-page-rollback-"));
  const db = new DatabaseSync(":memory:");
  try {
    for (const migration of listMigrations(defaultMigrationsDir).filter(
      (m) => m.version < 23,
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
      join(defaultMigrationsDir, "0023_workbench_pagination.sql"),
      "utf8",
    );
    writeFileSync(
      join(dir, "0023_workbench_pagination.sql"),
      `${sql}\nSELECT * FROM missing_pagination_table;`,
    );
    expect(() => migrate(db, dir)).toThrow(/missing_pagination_table/u);
    expect(
      db.prepare("SELECT MAX(version) AS n FROM schema_version").get()?.n,
    ).toBe(22);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name IN ('events_by_time','runs_by_number','timeline_by_action')",
        )
        .all(),
    ).toEqual([]);
    writeFileSync(join(dir, "0023_workbench_pagination.sql"), sql);
    expect(migrate(db, dir)).toEqual([
      { version: 23, name: "workbench_pagination" },
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
