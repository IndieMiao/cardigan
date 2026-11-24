import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { hostOpsLockHolder, tryHostOpsLock } from "./host-ops-lock.js";
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

test("C-678: the attach holder is readable while held and ignored once released or its process is gone", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "host-ops-holder-"));
  const store = Store.open({ dataDir });
  try {
    const holder = {
      kind: "attach",
      mode: "interactive",
      started_at: "2026-11-24T05:00:00.000Z",
    } as const;
    const release = await tryHostOpsLock(
      store,
      "fixture",
      "A-1" as never,
      "host-ops",
      holder,
    );
    expect(await hostOpsLockHolder(store, "fixture", "A-1" as never)).toEqual({
      ...holder,
      pid: process.pid,
    });
    expect(
      await hostOpsLockHolder(store, "fixture", "A-2" as never),
    ).toBeUndefined();
    await release?.();
    expect(
      await hostOpsLockHolder(store, "fixture", "A-1" as never),
    ).toBeUndefined();
    // A record left behind by a process that exited is not an attached human.
    const dead = execFileSync(process.execPath, ["-p", "process.pid"], {
      encoding: "utf8",
    }).trim();
    await writeFile(
      join(dataDir, "locks", "host-ops-fixture-A-1.lock.holder.json"),
      JSON.stringify({ ...holder, pid: Number(dead) }),
    );
    expect(
      await hostOpsLockHolder(store, "fixture", "A-1" as never),
    ).toBeUndefined();
    // Lock kinds other than an attach never record a holder.
    const plain = await tryHostOpsLock(store, "fixture", "A-3" as never);
    expect(
      await hostOpsLockHolder(store, "fixture", "A-3" as never),
    ).toBeUndefined();
    await plain?.();
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
