import type { DeploymentDriver, DeploymentRecord } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import { DeploymentController } from "./deployment.js";

function fixture() {
  const calls: string[] = [];
  const records: DeploymentRecord[] = [];
  const old = { sha: "a".repeat(40), release: "old" };
  const next = { sha: "b".repeat(40), release: "next" };
  const driver: DeploymentDriver = {
    enabled: true,
    current: async () => old,
    main: async () => next.sha,
    isFastForward: async () => true,
    passedMergeGate: async () => true,
    acquire: async () => async () => {
      calls.push("unlock");
    },
    build: async () => {
      calls.push("build");
      return { build: next, log_tail: "" };
    },
    migrationsChanged: async () => true,
    backup: async () => {
      calls.push("backup");
    },
    stop: async () => {
      calls.push("stop");
    },
    start: async (build) => {
      calls.push(`start:${build.release}`);
    },
    ready: async () => {
      calls.push("ready");
      return true;
    },
    promote: async (build) => {
      calls.push(`promote:${build.release}`);
    },
    refreshRoles: async () => {
      calls.push("roles");
    },
    record: async (record) => {
      records.push(record);
    },
    now: () => 100,
  };
  return { driver, calls, records };
}

test("build succeeds before stop, backup precedes migrations, readiness precedes promotion", async () => {
  const f = fixture();
  await new DeploymentController(f.driver).tick();
  expect(f.calls).toEqual([
    "build",
    "stop",
    "backup",
    "start:next",
    "ready",
    "promote:next",
    "roles",
    "unlock",
  ]);
  expect(f.records.at(-1)).toMatchObject({
    status: "deployed",
    build: "passed",
    ready: true,
  });
});

test.each(["isFastForward", "passedMergeGate"] as const)(
  "%s refuses unapproved code without building or stopping",
  async (key) => {
    const f = fixture();
    f.driver[key] = async () => false;
    await new DeploymentController(f.driver).tick();
    expect(f.calls).toEqual(["unlock"]);
    expect(f.records.at(-1)?.status).toBe("failed");
  },
);

test("nonzero build never stops the running server and is not retried every tick", async () => {
  const f = fixture();
  f.driver.build = async () => ({ log_tail: "sanitized failure" });
  const c = new DeploymentController(f.driver);
  await c.tick();
  await c.tick();
  expect(f.calls).toEqual(["unlock", "unlock"]);
  expect(f.records.at(-1)).toMatchObject({
    status: "failed",
    build: "failed",
    downtime_ms: 0,
  });
});

test("ready timeout stops the candidate and restores the previous build", async () => {
  const f = fixture();
  f.driver.ready = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  await new DeploymentController(f.driver).tick();
  expect(f.calls).toContain("start:old");
  expect(f.calls).not.toContain("promote:next");
  expect(f.calls).toContain("promote:old");
  expect(f.calls).not.toContain("roles");
  expect(f.records.at(-1)).toMatchObject({
    status: "rolled_back",
    ready: true,
  });
});

test("an unconfirmed stop never starts a second server", async () => {
  const f = fixture();
  f.driver.stop = async () => {
    throw new Error("unknown process");
  };
  await new DeploymentController(f.driver).tick();
  expect(f.calls).toEqual(["build", "unlock"]);
  expect(f.records.at(-1)?.status).toBe("failed");
});

test("occupied merge capacity and disabled configuration do nothing", async () => {
  const f = fixture();
  f.driver.acquire = async () => undefined;
  await new DeploymentController(f.driver).tick();
  expect(f.records).toEqual([]);
  await new DeploymentController({
    ...f.driver,
    enabled: false,
    acquire: async () => {
      throw new Error("must not acquire");
    },
  }).tick();
});

test("concurrent ticks cannot enter a second deployment", async () => {
  const f = fixture();
  let resume!: () => void;
  f.driver.build = async () => {
    await new Promise<void>((resolve) => {
      resume = resolve;
    });
    return { log_tail: "failure" };
  };
  const c = new DeploymentController(f.driver);
  const first = c.tick();
  await vi.waitFor(() => expect(resume).toBeTypeOf("function"));
  await c.tick();
  resume();
  await first;
  expect(f.records).toHaveLength(2);
});
