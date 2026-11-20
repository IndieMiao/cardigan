import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { feishuStatus, migrate, Store } from "./index.js";
import { migrationsThrough } from "./test-support.js";

test("upgrading a pre-application database does not bind an owner or enable the channel", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cardigan-feishu-upgrade-"));
  const store = Store.open({
    dataDir,
    migrationsDir: migrationsThrough(dataDir, 46),
  });
  try {
    const db = store.database;
    db.exec(
      `INSERT INTO ext_message_host_status VALUES (1,'{"fixture":"legacy"}')`,
    );
    expect(migrate(db)).toContainEqual({
      version: 1795181740756,
      name: "feishu_interactions",
    });
    expect(feishuStatus(db)).toMatchObject({ state: "disabled", bound: false });
    expect(db.prepare("SELECT * FROM feishu_bindings").all()).toEqual([]);
    expect(migrate(db)).toEqual([]);
    expect(db.prepare("SELECT * FROM ext_message_host_status").get()).toEqual({
      id: 1,
      doc: '{"fixture":"legacy"}',
    });
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
