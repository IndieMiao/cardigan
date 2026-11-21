import { verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { migrate, Store } from "./index.js";
import { migrationsThrough } from "./test-support.js";

test("migration is lazy and independent controller connections retain one signing identity", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "resource-key-"));
  const old = Store.open({
    dataDir,
    migrationsDir: migrationsThrough(dataDir, 1795181740756),
  });
  try {
    expect(migrate(old.database).map((m) => m.name)).toContain(
      "run_resource_authority",
    );
    expect(
      old.database
        .prepare("SELECT count(*) AS n FROM run_resource_authority")
        .get()?.n,
    ).toBe(0);
    const publicKey = old.runResources.publicKey();
    const next = Store.open({ dataDir });
    try {
      expect(next.runResources.publicKey()).toBe(publicKey);
      const sig = Buffer.from(next.runResources.signState("fixture"), "base64");
      expect(verify("sha256", Buffer.from("fixture"), publicKey, sig)).toBe(
        true,
      );
      expect(
        verify("sha256", Buffer.from("different state"), publicKey, sig),
      ).toBe(false);
    } finally {
      next.close();
    }
  } finally {
    old.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
