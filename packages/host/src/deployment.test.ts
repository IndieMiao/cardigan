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
    waitForCapacity: async (record) => {
      await driver.record(record);
    },
    releaseCapacityWait: async () => {},
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

test("human pin deploys a rollback through build, backup and readiness; unpin restores main evidence checks", async () => {
  const f = fixture();
  const controller = new DeploymentController(f.driver);
  f.driver.isFastForward = async () => false;
  f.driver.passedMergeGate = async () => false;
  f.driver.target = async () => ({
    sha: "b".repeat(40),
    control_event_id: "human-pin",
  });
  await controller.tick();
  expect(f.records.at(-1)).toMatchObject({
    status: "deployed",
    control_event_id: "human-pin",
    build: "passed",
    ready: true,
  });
  expect(f.calls).toContain("backup");
  f.driver.target = async () => ({ sha: "c".repeat(40) });
  f.driver.isFastForward = async () => true;
  f.calls.length = 0;
  await controller.tick();
  expect(f.records.at(-1)?.status).toBe("waiting_for_evidence");
  expect(f.calls).not.toContain("build");
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
  expect(f.calls).toEqual(["unlock"]);
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

test("occupied merge capacity is recorded while disabled configuration does not acquire", async () => {
  const f = fixture();
  f.driver.acquire = async () => undefined;
  await new DeploymentController(f.driver).tick();
  expect(f.records).toMatchObject([
    { status: "waiting_for_capacity", build: "not_run" },
  ]);
  expect(f.calls).toEqual([]);
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

test("no target, disabled deployment and failed observations withdraw the pending waiter", async () => {
  const f = fixture();
  const release = vi.fn(async () => {});
  f.driver.releaseCapacityWait = release;
  f.driver.acquire = vi.fn(async () => undefined);
  const controller = new DeploymentController(f.driver);
  await controller.tick();
  expect(release).not.toHaveBeenCalled();
  f.driver.main = async () => (await f.driver.current()).sha;
  await controller.tick();
  expect(release).toHaveBeenCalledTimes(1);
  expect(f.driver.acquire).toHaveBeenCalledTimes(1);
  f.driver.main = async () => {
    throw new Error("read failed");
  };
  await expect(controller.tick()).rejects.toThrow("read failed");
  expect(release).toHaveBeenCalledTimes(2);
  await new DeploymentController({ ...f.driver, enabled: false }).tick();
  expect(release).toHaveBeenCalledTimes(3);
});

/** C-650: a durable retry store shared by successive controllers (restarts). */
function retrying(f: ReturnType<typeof fixture>, max = 2, intervalMs = 60_000) {
  let now = Date.parse("2026-11-23T11:28:00.000Z");
  const driver: DeploymentDriver = {
    ...f.driver,
    readyRetryMax: max,
    readyRetryIntervalMs: intervalMs,
    now: () => now,
    // Mirrors readReadyRetry: the latest record of this target with retry state.
    readyRetryState: async (to, control) =>
      f.records.findLast(
        (r) => r.to === to && r.control_event_id === control && r.ready_retry,
      )?.ready_retry,
    serverFailureCause: () => "数据库被锁",
  };
  return {
    driver,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("C-650: a rolled-back ready failure retries on schedule, survives restart and stops at the limit", async () => {
  const f = fixture();
  f.driver.ready = vi.fn(async () => {
    f.calls.push("ready");
    // Candidate never ready; the restored previous build always is.
    return f.calls.filter((c) => c.startsWith("start:")).at(-1) === "start:old";
  });
  const r = retrying(f);
  const builds = () => f.calls.filter((c) => c === "build").length;
  let controller = new DeploymentController(r.driver);
  await controller.tick();
  expect(f.records.at(-1)).toMatchObject({
    status: "rolled_back",
    ready: true,
    failure_stage: "ready",
    ready_retry: {
      failures: 1,
      max: 2,
      next_at: "2026-11-23T11:29:00.000Z",
    },
  });
  expect(f.records.at(-1)?.summary).toBe(
    "ready_failed（数据库被锁）；已恢复上一构建；不早于 60 秒后自动重试（第 1/2 次）",
  );
  // Not due yet: no build, no stop.
  r.advance(59_999);
  await controller.tick();
  expect(builds()).toBe(1);
  // A restarted supervisor reads the durable count instead of starting over.
  r.advance(1);
  controller = new DeploymentController(r.driver);
  await controller.tick();
  expect(builds()).toBe(2);
  expect(f.records.at(-1)?.ready_retry).toMatchObject({ failures: 2, max: 2 });
  r.advance(60_000);
  controller = new DeploymentController(r.driver);
  await controller.tick();
  expect(builds()).toBe(3);
  expect(f.records.at(-1)).toMatchObject({
    status: "rolled_back",
    ready_retry: { failures: 3, max: 2 },
  });
  expect(f.records.at(-1)?.ready_retry?.next_at).toBeUndefined();
  expect(f.records.at(-1)?.summary).toContain(
    "已自动重试 2 次仍失败，需主机处理",
  );
  // Used up: neither this controller nor a restarted one tries again.
  r.advance(3_600_000);
  await controller.tick();
  await new DeploymentController(r.driver).tick();
  expect(builds()).toBe(3);
});

test("C-650: a retry that becomes ready deploys; a failed rollback is never retried", async () => {
  const f = fixture();
  f.driver.ready = vi
    .fn()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true);
  const r = retrying(f);
  const controller = new DeploymentController(r.driver);
  await controller.tick();
  r.advance(60_000);
  await controller.tick();
  expect(f.records.at(-1)?.status).toBe("deployed");

  const g = fixture();
  g.driver.ready = vi.fn().mockResolvedValue(false);
  const s = retrying(g);
  await new DeploymentController(s.driver).tick();
  expect(g.records.at(-1)).toMatchObject({
    status: "failed",
    ready: false,
    ready_retry: { failures: 1, max: 2 },
  });
  expect(g.records.at(-1)?.ready_retry?.next_at).toBeUndefined();
  s.advance(3_600_000);
  await new DeploymentController(s.driver).tick();
  expect(g.calls.filter((c) => c === "build")).toHaveLength(1);
});

test("C-650: a human pin counts separately; build failures keep the in-memory rule", async () => {
  const f = fixture();
  f.driver.ready = vi.fn(async () => {
    f.calls.push("ready");
    return f.calls.filter((c) => c.startsWith("start:")).at(-1) === "start:old";
  });
  const r = retrying(f, 0);
  await new DeploymentController(r.driver).tick();
  expect(f.records.at(-1)).toMatchObject({
    status: "rolled_back",
    ready_retry: { failures: 1, max: 0 },
  });
  // A new pin of the same commit is its own target.
  r.driver.target = async () => ({
    sha: "b".repeat(40),
    control_event_id: "human-pin",
  });
  await new DeploymentController(r.driver).tick();
  expect(f.calls.filter((c) => c === "build")).toHaveLength(2);
  expect(f.records.at(-1)).toMatchObject({
    control_event_id: "human-pin",
    ready_retry: { failures: 1, max: 0 },
  });

  const g = fixture();
  g.driver.build = async () => {
    g.calls.push("build");
    return { log_tail: "build: exit 1" };
  };
  const s = retrying(g);
  const controller = new DeploymentController(s.driver);
  await controller.tick();
  s.advance(3_600_000);
  await controller.tick();
  expect(g.records.at(-1)?.ready_retry).toBeUndefined();
  expect(g.records.at(-1)?.summary).toBe("build_failed");
  expect(g.calls.filter((c) => c === "build")).toHaveLength(1);
});

test("C-390: an open maintenance window holds automatic deployment", async () => {
  const f = fixture();
  let open = true;
  const driver = { ...f.driver, maintenanceActive: async () => open };
  const controller = new DeploymentController(driver);
  await controller.tick();
  expect(f.calls).toEqual([]);
  expect(f.records).toEqual([]);
  open = false;
  await controller.tick();
  expect(f.calls).toContain("build");
});
