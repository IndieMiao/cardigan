import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { migrate, Store } from "./index.js";
import { migrationsThrough } from "./test-support.js";

test("upgrading the resource-lease schema adds the check journal without changing reservations", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-check-upgrade-"));
  const store = Store.open({
    dataDir,
    migrationsDir: migrationsThrough(dataDir, 45),
  });
  try {
    const db = store.database;
    db.exec(`INSERT INTO machine_resource_leases
      (generation, machine, resource, project, starts_at, ends_at, endpoints)
      VALUES ('reservation', 'fixture', 'device', 'p', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', '[]')`);
    const leases = db.prepare("SELECT * FROM machine_resource_leases");
    const before = leases.all();
    expect(migrate(db)).toContainEqual({
      version: 46,
      name: "machine_check_jobs",
    });
    expect(db.prepare("SELECT id FROM machine_check_jobs").all()).toEqual([]);
    expect(leases.all()).toEqual(before);
    expect(migrate(db)).toEqual([]);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
