import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  listNotifications,
  moveNotification,
  recordNotification,
} from "./inbox.js";
import { defaultMigrationsDir, listMigrations, migrate } from "./migrate.js";
import { Store } from "./store.js";
import { card, event } from "./test-support.js";

test("notification index preserves ordering, revisions and transitions, and migrates atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "notification-status-"));
  const migrations = listMigrations(defaultMigrationsDir);
  const lookup = migrations.find((m) => m.name === "notification_status");
  if (!lookup) throw new Error("Missing migration");
  const path = (v: number, name: string) =>
    join(dir, `${String(v).padStart(4, "0")}_${name}.sql`);
  for (const m of migrations.filter((m) => m.version < lookup.version))
    writeFileSync(path(m.version, m.name), m.sql);
  const store = Store.open({
    dbPath: join(dir, "copy.db"),
    migrationsDir: dir,
  });
  const db = store.database;
  try {
    for (const project of ["p", "other"]) {
      store.createProject({ id: project });
      store.uow.run((tx) => {
        tx.cards.put(project, card({ project_id: project }));
        for (let i = 1; i <= 8; i++) {
          tx.events.append(project, event({ seq: i }));
          const n = recordNotification(db, {
            project_id: project,
            event_id: event({ seq: i }).id,
            recipient: { kind: "pm_ops" },
            id: `n-${i}`,
            seq: i % 3,
            kind: "test",
          }).notification;
          if (i % 2 === 0)
            moveNotification(db, {
              project_id: project,
              id: n.id,
              event: "ack",
            });
          else if (i === 3)
            moveNotification(db, {
              project_id: project,
              id: n.id,
              event: "needs_attention",
            });
        }
      });
    }
    const query = {
      project_id: "p",
      statuses: ["pending", "needs_attention"] as const,
    };
    const before = listNotifications(db, query);
    const snapshot = () =>
      ["notifications", "command_versions", "command_rows"].map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      );
    const rows = snapshot();
    const file = path(lookup.version, lookup.name);
    writeFileSync(
      file,
      `${lookup.sql}\nSELECT * FROM missing_notification_table;`,
    );
    expect(() => migrate(db, dir)).toThrow("missing_notification_table");
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'notifications_by_status'",
        )
        .get(),
    ).toBeUndefined();
    expect(snapshot()).toEqual(rows);
    writeFileSync(file, lookup.sql);
    expect(migrate(db, dir)).toEqual([
      { version: lookup.version, name: lookup.name },
    ]);
    expect(migrate(db, dir)).toEqual([]);
    expect(snapshot()).toEqual(rows);
    expect(listNotifications(db, query)).toEqual(before);
    expect(listNotifications(db, query).map((n) => n.id)).toEqual([
      "n-3",
      "n-1",
      "n-7",
      "n-5",
    ]);
    const sql =
      "SELECT doc FROM notifications WHERE project_id = ? AND status IN (SELECT value FROM json_each(?)) ORDER BY seq, id";
    expect(
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all("p", JSON.stringify(query.statuses))
        .map((r) => r.detail)
        .join(" "),
    ).toContain("notifications_by_status (project_id=? AND status=?)");
    store.uow.run(() =>
      moveNotification(db, { project_id: "p", id: "n-1", event: "ack" }),
    );
    expect(listNotifications(db, query).map((n) => n.id)).toEqual([
      "n-3",
      "n-7",
      "n-5",
    ]);
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe(
      "ok",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
