import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { defaultMigrationsDir, Store } from "./index.js";
import { PROJECT_CODES_MIGRATION_NAME } from "./project-codes.js";
import { withTempStore } from "./test-support.js";

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

test("a new project registers a valid, unique code; omitted codes are suggested", () => {
  // Distinct creation times keep `listProjects()` in creation order.
  let tick = 0;
  const clock = {
    now: () => `2026-11-24T00:00:00.${String(tick++).padStart(3, "0")}Z`,
  };
  withTempStore(
    (store) => {
      expect(
        store.createProject({ id: "sensen-godot", code: "SEN" }),
      ).toMatchObject({ ok: true, value: { code: "SEN" } });
      // Suggested from the name; the taken three-character stem moves to four.
      expect(store.createProject({ id: "sensei" })).toMatchObject({
        ok: true,
        value: { code: "SENS" },
      });
      expect(store.createProject({ id: "cardigan" }).ok).toBe(true);
      expect(store.getProject("cardigan")?.code).toBe("CAR");
      expect(store.projectByCode("SEN")?.id).toBe("sensen-godot");
      expect(store.projectCode("sensei")).toBe("SENS");
      expect(store.listProjects().map((p) => p.code)).toEqual([
        "SEN",
        "SENS",
        "CAR",
      ]);
    },
    { clock },
  );
});

test("project codes are validated and globally unique", () => {
  withTempStore((store) => {
    store.createProject({ id: "a", code: "ABC" });
    for (const code of ["abc", "AB", "ABCDE", "1AB", "A-B", "ABC"]) {
      const created = store.createProject({ id: `p-${code.length}`, code });
      expect(created.ok, code).toBe(false);
    }
    expect(store.listProjects()).toHaveLength(1);
    // The unique index also refuses a code written past the API.
    store.createProject({ id: "b", code: "B12" });
    expect(() =>
      store.database
        .prepare("UPDATE projects SET code = NULL WHERE id = 'b'")
        .run(),
    ).toThrow(/immutable/u);
  });
});

test("a registered code never changes", () => {
  withTempStore((store) => {
    store.createProject({ id: "a", code: "ABC" });
    const again = store.setProjectCode({ project_id: "a", code: "ABD" });
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error.message).toContain("不可修改");
    expect(() =>
      store.database
        .prepare("UPDATE projects SET code = 'ABD' WHERE id = 'a'")
        .run(),
    ).toThrow(/immutable/u);
    expect(store.getProject("a")?.code).toBe("ABC");
  });
});

test("the migration backfills the owner's codes, then suggestions in creation order", () => {
  const dataDir = tempDir("cardigan-codes-");
  const migrationsDir = tempDir("cardigan-codes-migrations-");
  const files = readdirSync(defaultMigrationsDir);
  for (const file of files)
    if (!file.endsWith(`_${PROJECT_CODES_MIGRATION_NAME}.sql`))
      copyFileSync(join(defaultMigrationsDir, file), join(migrationsDir, file));
  const dbPath = join(dataDir, "cardigan.db");
  let tick = 0;
  const clock = {
    now: () => `2026-11-24T00:00:00.${String(tick++).padStart(3, "0")}Z`,
  };
  const old = Store.open({ dbPath, migrationsDir, clock });
  for (const id of ["cardigan", "car-wash", "sensen-godot", "senate"])
    expect(old.createProject({ id }).ok).toBe(true);
  expect(old.getProject("cardigan")?.code).toBeNull();
  old.close();

  const current = Store.open({ dbPath, clock });
  try {
    expect(
      Object.fromEntries(current.listProjects().map((p) => [p.id, p.code])),
    ).toEqual({
      cardigan: "CDG",
      "car-wash": "CAR",
      "sensen-godot": "SEN",
      senate: "SENA",
    });
    expect(
      current.setProjectCode({ project_id: "senate", code: "SNT" }).ok,
    ).toBe(false);
  } finally {
    current.close();
  }
});
