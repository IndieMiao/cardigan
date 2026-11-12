import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { tryHostOpsLock } from "./host-ops-lock.js";
import { acquireRepositoryFlock } from "./repository-lock.js";

const exec = promisify(execFile);
test.runIf(process.platform === "linux")(
  "operation mutex spans Store connections and processes and has no lease expiry",
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "host-ops-lock-"));
    const first = Store.open({ dataDir }),
      second = Store.open({ dataDir });
    const path = join(dataDir, "locks", "host-ops-fixture-A-1.lock");
    const release = await tryHostOpsLock(first, "fixture", "A-1" as never);
    try {
      expect(release).toBeDefined();
      expect(
        await tryHostOpsLock(second, "fixture", "A-1" as never),
      ).toBeUndefined();
      await expect(
        exec("flock", ["--nonblock", path, "true"]),
      ).rejects.toMatchObject({ code: 1 });
      await release?.();
      // A separate file description bypasses the JS registry, like another process.
      const external = await acquireRepositoryFlock(path, 1000);
      try {
        expect(
          await tryHostOpsLock(second, "fixture", "A-1" as never),
        ).toBeUndefined();
      } finally {
        await external();
      }
      const next = await tryHostOpsLock(second, "fixture", "A-1" as never);
      expect(next).toBeDefined();
      await next?.();
      await expect(
        exec("flock", ["--nonblock", path, "true"]),
      ).resolves.toBeDefined();
    } finally {
      await release?.();
      first.close();
      second.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);
