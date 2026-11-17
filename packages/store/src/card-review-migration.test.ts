import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { defaultMigrationsDir, listMigrations, migrate } from "./migrate.js";
import { Store } from "./store.js";
import { card, event } from "./test-support.js";

test("review lookup upgrade rolls back on failure, preserves data and revisions, and repeats safely", () => {
  const dir = mkdtempSync(join(tmpdir(), "card-review-migration-"));
  const migrations = listMigrations(defaultMigrationsDir);
  const lookup = migrations.find((m) => m.name === "card_review_lookup");
  if (!lookup) throw new Error("Missing migration");
  const filename = (version: number, name: string) =>
    join(dir, `${String(version).padStart(4, "0")}_${name}.sql`);
  for (const m of migrations.filter((m) => m.version < lookup.version))
    writeFileSync(filename(m.version, m.name), m.sql);
  const store = Store.open({
    dbPath: join(dir, "copy.db"),
    migrationsDir: dir,
  });
  const db = store.database;
  try {
    store.createProject({ id: "p" });
    store.uow.run((tx) => {
      tx.cards.put("p", card());
      tx.events.append("p", event({ seq: 1 }));
    });
    const insert = db.prepare("INSERT INTO reviews VALUES (?, ?, ?, ?)");
    for (const project of ["p", "other"])
      for (const [id, work_item_id] of [
        ["V-1", "W-1"],
        ["V-2", null],
        ["V-3", "W-2"],
      ])
        insert.run(project, id, "D-1", JSON.stringify({ id, work_item_id }));
    const snapshot = () =>
      ["reviews", "events", "command_versions", "command_rows"].map((table) =>
        db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      );
    const before = snapshot();
    const path = filename(lookup.version, lookup.name);
    writeFileSync(
      path,
      `${lookup.sql}\nSELECT * FROM missing_review_lookup_table;`,
    );
    expect(() => migrate(db, dir)).toThrow("missing_review_lookup_table");
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'reviews_by_work_item'",
        )
        .get(),
    ).toBeUndefined();
    expect(store.schemaVersion()).toBe(lookup.version - 1);
    expect(snapshot()).toEqual(before);
    writeFileSync(path, lookup.sql);
    expect(migrate(db, dir)).toEqual([
      { version: lookup.version, name: lookup.name },
    ]);
    expect(migrate(db, dir)).toEqual([]);
    expect(snapshot()).toEqual(before);
    const sql =
      "SELECT doc FROM reviews WHERE project_id = ? AND json_extract(doc, '$.work_item_id') IN (SELECT value FROM json_each(?))";
    expect(
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all("p", '["W-1"]')
        .map((r) => r.detail)
        .join(" "),
    ).toContain("reviews_by_work_item (project_id=? AND <expr>=?)");
    expect(
      db
        .prepare(sql)
        .all("p", '["W-1"]')
        .map((r) => JSON.parse(String(r.doc)).id),
    ).toEqual(["V-1"]);
    store.uow.run((tx) => tx.events.append("p", event({ seq: 2 })));
    expect(
      store.uow.read((tx) => tx.events.listAfter("p", "C-1", 0)),
    ).toHaveLength(2);
    expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe(
      "ok",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
