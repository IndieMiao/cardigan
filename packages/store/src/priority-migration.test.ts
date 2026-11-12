import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { defaultMigrationsDir, listMigrations, Store } from "./index.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function legacy() {
  const dataDir = mkdtempSync(join(tmpdir(), "priority-data-"));
  const migrationsDir = mkdtempSync(join(tmpdir(), "priority-schema-"));
  dirs.push(dataDir, migrationsDir);
  for (const migration of listMigrations(defaultMigrationsDir).filter(
    (m) => m.version < 19,
  )) {
    const name = `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`;
    copyFileSync(join(defaultMigrationsDir, name), join(migrationsDir, name));
  }
  const store = Store.open({ dataDir, migrationsDir });
  const old = [-3, 0, 0.5, 1, 2, 2.5, 3, 4, 5, 99];
  old.forEach((priority, i) => {
    store.database
      .prepare("INSERT INTO cards VALUES (?, ?, ?)")
      .run(
        "p",
        `C-${i + 1}`,
        JSON.stringify({ id: `C-${i + 1}`, priority, title: "kept" }),
      );
  });
  store.close();
  return dataDir;
}
test("v19 maps existing numbers once, preserving the other card fields", () => {
  const dataDir = legacy();
  const store = Store.open({ dataDir });
  try {
    const cards = store.database
      .prepare("SELECT doc FROM cards ORDER BY rowid")
      .all()
      .map((r) => JSON.parse(String(r.doc)));
    expect(cards.map((c) => c.priority)).toEqual([
      0, 0, 1, 1, 2, 3, 3, 3, 4, 4,
    ]);
    expect(cards.every((c) => c.title === "kept")).toBe(true);
    vi.stubEnv("CARDIGAN_PRIORITY_MIGRATION_THRESHOLDS", "10,20,30");
    expect(store.migrate()).toEqual([]);
    expect(
      store.database
        .prepare("SELECT doc FROM cards ORDER BY rowid")
        .all()
        .map((r) => JSON.parse(String(r.doc))),
    ).toEqual(cards);
  } finally {
    store.close();
  }
});
test("operators can configure thresholds before upgrading; invalid settings roll back", () => {
  const dataDir = legacy();
  vi.stubEnv("CARDIGAN_PRIORITY_MIGRATION_THRESHOLDS", "2,,4");
  expect(() => Store.open({ dataDir })).toThrow(
    "CARDIGAN_PRIORITY_MIGRATION_THRESHOLDS",
  );
  vi.stubEnv("CARDIGAN_PRIORITY_MIGRATION_THRESHOLDS", "2,4,8");
  const store = Store.open({ dataDir });
  try {
    expect(
      store.database
        .prepare("SELECT doc FROM cards ORDER BY rowid")
        .all()
        .map((r) => JSON.parse(String(r.doc)).priority),
    ).toEqual([0, 0, 1, 1, 1, 2, 2, 2, 3, 4]);
  } finally {
    store.close();
  }
});
