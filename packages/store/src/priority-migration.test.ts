import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vitest";
import { defaultMigrationsDir, listMigrations, Store } from "./index.js";
import { priorityMigrationThresholds } from "./priority-migration.js";
import { latestSchemaVersion } from "./test-support.js";

const dirs: string[] = [];
const oldValues = [-3, 0, 0.5, 1, 2, 2.5, 3, 4, 5, 99, Number.MAX_VALUE];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function legacy(version = 18) {
  const dataDir = mkdtempSync(join(tmpdir(), "priority-data-"));
  const migrationsDir = mkdtempSync(join(tmpdir(), "priority-schema-"));
  dirs.push(dataDir, migrationsDir);
  for (const migration of listMigrations(defaultMigrationsDir).filter(
    (m) => m.version <= version,
  )) {
    const name = `${String(migration.version).padStart(4, "0")}_${migration.name}.sql`;
    copyFileSync(join(defaultMigrationsDir, name), join(migrationsDir, name));
  }
  const store = Store.open({ dataDir, migrationsDir });
  expect(store.schemaVersion()).toBe(version);
  oldValues.forEach((priority, i) => {
    store.database.prepare("INSERT INTO cards VALUES (?, ?, ?)").run(
      "p",
      `C-${i + 1}`,
      JSON.stringify({
        id: `C-${i + 1}`,
        priority,
        title: "kept",
        source: {
          kind: "decision",
          decision_id: version < 18 ? "q(7)" : "Q-7",
        },
      }),
    );
  });
  store.close();
  return dataDir;
}
const cards = (db: DatabaseSync) =>
  db
    .prepare("SELECT doc FROM cards ORDER BY rowid")
    .all()
    .map((row) => JSON.parse(String(row.doc)));

test.each([17, 18])(
  "v19 migrates schema %s after readable IDs, with no automatic Urgent and no repeat",
  (version) => {
    const dataDir = legacy(version);
    const store = Store.open({ dataDir });
    try {
      const migrated = cards(store.database);
      expect(migrated.map((card) => card.priority)).toEqual([
        0, 0, 1, 1, 2, 3, 3, 3, 3, 3, 3,
      ]);
      expect(migrated.some((card) => card.priority === 4)).toBe(false);
      expect(
        migrated.every(
          (card) => card.title === "kept" && card.source.decision_id === "Q-7",
        ),
      ).toBe(true);
      expect(store.schemaVersion()).toBe(latestSchemaVersion());
      expect(
        store.database
          .prepare(
            "SELECT version, name FROM schema_version WHERE version BETWEEN 18 AND 19 ORDER BY version",
          )
          .all(),
      ).toEqual([
        { version: 18, name: "readable_id_format" },
        { version: 19, name: "card_priorities" },
      ]);
      const versions = listMigrations(defaultMigrationsDir).map(
        (migration) => migration.version,
      );
      expect(new Set(versions).size).toBe(versions.length);
      vi.stubEnv("CARDIGAN_PRIORITY_MIGRATION_THRESHOLDS", "10,20,30");
      expect(store.migrate()).toEqual([]);
      expect(cards(store.database)).toEqual(migrated);
    } finally {
      store.close();
    }
  },
);

test.each([
  ["2,4,unbounded", [0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3]],
  ["2,4,8", [0, 0, 1, 1, 1, 2, 2, 2, 3, 4, 4]],
] as const)(
  "operators can select exact or finite High bounds: %s",
  (config, expected) => {
    const dataDir = legacy();
    vi.stubEnv("CARDIGAN_PRIORITY_MIGRATION_THRESHOLDS", config);
    const store = Store.open({ dataDir });
    try {
      expect(cards(store.database).map((card) => card.priority)).toEqual(
        expected,
      );
    } finally {
      store.close();
    }
  },
);

test.each([
  "",
  "1,2",
  "1,2,3,4",
  "0,2,unbounded",
  "2,1,unbounded",
  "1,1,unbounded",
  "1,2,1",
  "unbounded,2,4",
  "1,unbounded,4",
  "1,2,Infinity",
  "1,2,-Infinity",
  "1,2,NaN",
  "1,2,1e309",
  "1,,unbounded",
  "1,2,*",
])("rejects malformed migration bounds %j", (config) => {
  expect(() => priorityMigrationThresholds(config)).toThrow(
    "CARDIGAN_PRIORITY_MIGRATION_THRESHOLDS",
  );
});

test("an invalid v19 configuration keeps schema 18 and card data, then a corrected configuration upgrades", () => {
  const dataDir = legacy();
  vi.stubEnv("CARDIGAN_PRIORITY_MIGRATION_THRESHOLDS", "2,,unbounded");
  expect(() => Store.open({ dataDir })).toThrow(
    "CARDIGAN_PRIORITY_MIGRATION_THRESHOLDS",
  );
  const db = new DatabaseSync(join(dataDir, "cardigan.db"));
  try {
    expect(cards(db).map((card) => card.priority)).toEqual(oldValues);
    expect(
      db.prepare("SELECT MAX(version) AS version FROM schema_version").get()
        ?.version,
    ).toBe(18);
  } finally {
    db.close();
  }
  vi.stubEnv("CARDIGAN_PRIORITY_MIGRATION_THRESHOLDS", "1,2,unbounded");
  const store = Store.open({ dataDir });
  try {
    expect(cards(store.database).map((card) => card.priority)).toEqual([
      0, 0, 1, 1, 2, 3, 3, 3, 3, 3, 3,
    ]);
  } finally {
    store.close();
  }
});
