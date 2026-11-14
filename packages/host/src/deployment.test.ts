import type { DeploymentDriver, DeploymentRecord } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import {
  DeploymentController,
  DeploymentServerUnavailable,
} from "./deployment.js";

function fixture() {
  const calls: string[] = [];
  const records: DeploymentRecord[] = [];
  const old = { sha: "a".repeat(40), release: "old" };
  const next = { sha: "b".repeat(40), release: "next" };
  const driver: DeploymentDriver = {
    enabled: true,
    checkServer: async () => {},
    current: async () => old,
    main: async () => next.sha,
    isFastForward: async () => true,
    passedMergeGate: async () => true,
    waitForEvidence: async (record) => {
      if (!records.some((r) => r.status === "waiting_for_evidence"))
        await driver.record(record);
    },
    serverDiagnostics: (stage) => `${stage}: exit unknown`,
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
      return "database-00000000-0000-0000-0000-000000000001.bak";
    },
    beforeStop: async (record) => {
      calls.push("snapshot");
      const next: DeploymentRecord = {
        ...record,
        status: "stopping",
        stop_snapshot: {
          captured_at: "2026-11-13T00:00:00.000Z",
          runs: [],
        },
      };
      records.push(next);
      return next;
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
    "snapshot",
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

test("non-fast-forward main fails without building or stopping", async () => {
  const f = fixture();
  f.driver.isFastForward = async () => false;
  await new DeploymentController(f.driver).tick();
  expect(f.calls).toEqual(["unlock"]);
  expect(f.records.at(-1)?.status).toBe("failed");
});

test("pending publication evidence is rechecked without repeated alerts or failed-target caching", async () => {
  const f = fixture();
  const gate = vi.fn().mockResolvedValue(false);
  f.driver.passedMergeGate = gate;
  const c = new DeploymentController(f.driver);
  await c.tick();
  await c.tick();
  expect(f.calls).toEqual(["unlock", "unlock"]);
  expect(f.records).toHaveLength(1);
  expect(f.records[0]).toMatchObject({
    status: "waiting_for_evidence",
    build: "not_run",
  });
  gate.mockResolvedValue(true);
  await c.tick();
  expect(gate).toHaveBeenCalledTimes(3);
  expect(f.calls).toContain("build");
  expect(f.records.at(-1)?.status).toBe("deployed");
});

test.each(["unchanged", "disabled", "merge_check"])(
  "server supervision runs when deployment is %s",
  async (mode) => {
    const f = fixture();
    f.driver.checkServer = async () => {
      throw new Error("Server exited");
    };
    f.driver.main = async () => (await f.driver.current()).sha;
    if (mode === "merge_check") f.driver.acquire = async () => undefined;
    const c = new DeploymentController({
      ...f.driver,
      enabled: mode !== "disabled",
    });
    await expect(c.tick()).rejects.toBeInstanceOf(DeploymentServerUnavailable);
    expect(f.calls).toEqual([]);
  },
);

test.each(["read", "audit"])(
  "a transient evidence %s error does not permanently suppress deployment",
  async (stage) => {
    const f = fixture();
    const gate = vi.fn().mockResolvedValue(true);
    f.driver.passedMergeGate = gate;
    if (stage === "read")
      gate.mockRejectedValueOnce(new Error("Read unavailable"));
    else {
      gate.mockResolvedValueOnce(false);
      f.driver.record = vi
        .fn(f.driver.record)
        .mockRejectedValueOnce(new Error("Audit unavailable"));
    }
    const c = new DeploymentController(f.driver);
    await expect(c.tick()).rejects.toThrow("unavailable");
    expect(f.calls).toEqual(["unlock"]);
    await c.tick();
    expect(f.calls).toContain("build");
    expect(f.records.at(-1)?.status).toBe("deployed");
    expect(f.records.some((record) => record.status === "failed")).toBe(false);
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
    backup_file: "database-00000000-0000-0000-0000-000000000001.bak",
    failure_stage: "ready",
    stop_snapshot: f.records.find((r) => r.status === "stopping")
      ?.stop_snapshot,
  });
});

test.each([
  "build",
  "migrationsChanged",
  "beforeStop",
  "stop",
  "backup",
  "start",
  "ready",
  "promote",
  "refreshRoles",
] as const)(
  "%s exceptions never enter deployment records as raw text",
  async (stage) => {
    const f = fixture();
    const build = f.driver.build;
    const safeLog = "install: exit 0\nbuild: exit 0";
    f.driver.build = async (sha) => ({
      ...(await build(sha)),
      log_tail: safeLog,
    });
    f.driver[stage] = async () => {
      throw new Error("Authorization: Bearer synthetic-lifecycle-secret");
    };
    await new DeploymentController(f.driver).tick();
    expect(f.records.length).toBeGreaterThan(1);
    expect(JSON.stringify(f.records)).not.toMatch(/Authorization|synthetic/);
    expect(f.records.at(-1)?.log_tail).toBe(
      stage === "build"
        ? undefined
        : stage === "start" || stage === "ready"
          ? `${stage}: exit unknown`
          : safeLog,
    );
    expect(f.records.at(-1)).toMatchObject(
      stage === "refreshRoles"
        ? { status: "deployed", post_deploy_failed: true }
        : {
            status: stage === "backup" ? "rolled_back" : "failed",
            summary: expect.stringContaining("host_operation_failed"),
          },
    );
  },
);

test("the stop snapshot is committed after build and before the stop signal", async () => {
  const f = fixture();
  f.driver.stop = async () => {
    expect(f.records.at(-1)?.status).toBe("stopping");
    expect(f.records.at(-1)?.stop_snapshot).toBeDefined();
    f.calls.push("stop");
  };
  await new DeploymentController(f.driver).tick();
  expect(f.calls.indexOf("build")).toBeLessThan(f.calls.indexOf("snapshot"));
  expect(f.calls.indexOf("snapshot")).toBeLessThan(f.calls.indexOf("stop"));
});

test("failure to persist the snapshot keeps the old server running", async () => {
  const f = fixture();
  f.driver.beforeStop = async () => {
    throw new Error("audit unavailable");
  };
  await new DeploymentController(f.driver).tick();
  expect(f.calls).toEqual(["build", "unlock"]);
  expect(f.records.at(-1)?.stop_snapshot).toBeUndefined();
});

test("an unconfirmed stop never starts a second server", async () => {
  const f = fixture();
  f.driver.stop = async () => {
    throw new Error("unknown process");
  };
  await new DeploymentController(f.driver).tick();
  expect(f.calls).toEqual(["build", "snapshot", "unlock"]);
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
