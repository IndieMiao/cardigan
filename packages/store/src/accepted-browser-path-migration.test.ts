import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { migrate, Store } from "./index.js";
import { migrationsThrough } from "./test-support.js";

test("v46 check jobs survive adding the browser path registry", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-browser-upgrade-"));
  const store = Store.open({
    dataDir,
    migrationsDir: migrationsThrough(dataDir, 46),
  });
  try {
    const db = store.database;
    db.exec(
      `INSERT INTO machine_check_jobs VALUES ('job','local','p','machine',1,'running',1,'fixture','{}')`,
    );
    const jobs = db.prepare("SELECT * FROM machine_check_jobs");
    const before = jobs.all();
    expect(migrate(db)).toContainEqual({
      version: 1795180513344,
      name: "accepted_browser_path",
    });
    expect(
      db.prepare("SELECT digest FROM accepted_browser_path").all(),
    ).toEqual([]);
    expect(jobs.all()).toEqual(before);
    expect(migrate(db)).toEqual([]);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
