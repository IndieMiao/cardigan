import type {
  DeploymentDriver,
  DeploymentOperation,
  DeploymentRecord,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { DeploymentController } from "./deployment.js";

const sha = (c: string) => c.repeat(40);
const signing: DeploymentOperation = {
  id: "op-1",
  kind: "mobile_signing",
  project_id: "sensen",
  card_id: "C-14",
  label: "受管送签（android）",
  started_at: "2026-11-23T01:00:00.000Z",
};

/** C-609: a fake supervisor host with a controllable clock and main. */
function fixture(options: { batch?: number; wait?: number } = {}) {
  const calls: string[] = [];
  const records: DeploymentRecord[] = [];
  const waits: DeploymentRecord[] = [];
  /** Operation detail handed to the driver for the source cards. */
  const detail: {
    waited: DeploymentOperation[][];
    interrupted: DeploymentOperation[][];
  } = {
    waited: [],
    interrupted: [],
  };
  const fence = { up: false, taken: 0, released: 0 };
  let time = 0;
  let current = { sha: sha("a"), release: "a" };
  let main = sha("b");
  let ops: DeploymentOperation[] = [];
  const driver: DeploymentDriver = {
    enabled: true,
    batchWindowMs: options.batch ?? 0,
    operationWaitMs: options.wait ?? 0,
    checkServer: async () => {},
    current: async () => current,
    main: async () => main,
    isFastForward: async () => true,
    passedMergeGate: async () => true,
    waitForEvidence: async () => {},
    waitForCapacity: async () => {},
    releaseCapacityWait: async () => {},
    serverDiagnostics: () => "",
    acquire: async () => {
      calls.push("acquire");
      return async () => {};
    },
    build: async (target) => {
      calls.push(`build:${target[0]}`);
      return { build: { sha: target, release: target[0] ?? "" }, log_tail: "" };
    },
    migrationsChanged: async () => false,
    backup: async () => "unused",
    beforeStop: async (record, interrupted = []) => {
      detail.interrupted.push([...interrupted]);
      const stopping: DeploymentRecord = { ...record, status: "stopping" };
      records.push(stopping);
      return stopping;
    },
    stop: async () => {
      // The stop decision always stands on a fence (C-609).
      expect(fence.up).toBe(true);
      calls.push("stop");
    },
    start: async (build) => {
      calls.push(`start:${build.release}`);
    },
    ready: async () => true,
    promote: async (build) => {
      current = build;
    },
    refreshRoles: async () => {},
    record: async (record) => {
      records.push(record);
    },
    now: () => time,
    operations: async () => ops,
    fenceOperations: async () => {
      fence.up = true;
      fence.taken++;
      return ops;
    },
    releaseOperationFence: async () => {
      fence.up = false;
      fence.released++;
    },
    waitForOperations: async (record, operations = []) => {
      waits.push(record);
      detail.waited.push([...operations]);
    },
    sleep: async (ms) => {
      calls.push(`sleep:${ms}`);
      time += ms;
    },
  };
  return {
    driver,
    calls,
    records,
    waits,
    detail,
    fence,
    controller: new DeploymentController(driver),
    advance: (ms: number) => {
      time += ms;
    },
    setMain: (c: string) => {
      main = sha(c);
    },
    setOps: (next: DeploymentOperation[]) => {
      ops = next;
    },
    get current() {
      return current.sha;
    },
  };
}

test("C-609: merges within the window after a restart deploy once, as the latest main", async () => {
  const f = fixture({ batch: 300_000 });
  await f.controller.tick(); // a → b: no earlier restart, deploys immediately
  expect(f.current).toBe(sha("b"));
  f.setMain("c");
  f.advance(60_000);
  await f.controller.tick();
  f.setMain("d");
  f.advance(60_000);
  await f.controller.tick();
  expect(f.calls.filter((c) => c.startsWith("build"))).toEqual(["build:b"]);
  expect(f.waits.map((w) => [w.status, w.to])).toEqual([
    ["waiting_for_batch", sha("c")],
    ["waiting_for_batch", sha("d")],
  ]);
  expect(f.waits[0]).toMatchObject({ batch_window_ms: 300_000 });
  f.advance(180_000);
  await f.controller.tick();
  expect(f.calls.filter((c) => c.startsWith("build"))).toEqual([
    "build:b",
    "build:d",
  ]);
  expect(f.current).toBe(sha("d"));
  expect(f.records.at(-1)).toMatchObject({
    status: "deployed",
    from: sha("b"),
    to: sha("d"),
  });
});

test("C-609: a human pin is never batched", async () => {
  const f = fixture({ batch: 300_000 });
  await f.controller.tick();
  f.driver.target = async () => ({ sha: sha("e"), control_event_id: "pin" });
  f.advance(1_000);
  await f.controller.tick();
  expect(f.current).toBe(sha("e"));
  expect(f.waits).toEqual([]);
});

test("C-609: in-flight operations defer the deployment before capacity is taken, then it proceeds", async () => {
  const f = fixture({ wait: 900_000 });
  f.setOps([signing]);
  await f.controller.tick();
  f.advance(30_000);
  await f.controller.tick();
  expect(f.calls).toEqual([]); // no capacity, build or stop while waiting
  expect(f.waits).toHaveLength(2);
  expect(f.waits[0]).toMatchObject({
    status: "waiting_for_operations",
    deferred_operations: [{ kind: "mobile_signing", count: 1 }],
  });
  // The deployment project's record names no other project, card or label.
  expect(f.waits[0]?.summary).toContain("受管送签 1 项");
  for (const secret of ["sensen", "C-14", "android"])
    expect(JSON.stringify(f.waits)).not.toContain(secret);
  // The detail goes to the driver, which writes it on the source card.
  expect(f.detail.waited[0]).toEqual([signing]);
  f.setOps([]);
  f.advance(30_000);
  await f.controller.tick();
  expect(f.calls).toEqual(["acquire", "build:b", "stop", "start:b"]);
  expect(f.records.find((r) => r.status === "stopping")).not.toHaveProperty(
    "interrupted_operations",
  );
});

test("C-609: the wait is bounded; at the deadline it deploys and records what it interrupted", async () => {
  const f = fixture({ wait: 900_000 });
  f.setOps([signing]);
  await f.controller.tick();
  f.advance(600_000);
  f.setMain("c"); // main keeps moving: the deadline is not extended
  await f.controller.tick();
  expect(f.calls).toEqual([]);
  f.advance(300_000);
  await f.controller.tick();
  expect(f.calls).toEqual(["acquire", "build:c", "stop", "start:c"]);
  const stopping = f.records.find((r) => r.status === "stopping");
  const counts = [{ kind: "mobile_signing", count: 1 }];
  expect(stopping).toMatchObject({ interrupted_operations: counts });
  expect(stopping?.summary).toContain("等待受管长操作已达上限，照常部署");
  expect(f.records.at(-1)).toMatchObject({
    status: "deployed",
    interrupted_operations: counts,
  });
  expect(f.detail.interrupted).toEqual([[signing]]);
  expect(JSON.stringify(f.records)).not.toContain("C-14");
  expect(f.fence).toMatchObject({ up: false, taken: 1, released: 1 });
});

test("C-609: an operation that starts during the build delays the stop until it ends", async () => {
  const f = fixture({ wait: 900_000 });
  const build = f.driver.build;
  f.driver.build = async (target) => {
    f.setOps([signing]);
    return build(target);
  };
  let polls = 0;
  const sleep = f.driver.sleep;
  f.driver.sleep = async (ms) => {
    if (++polls === 3) f.setOps([]);
    await sleep?.(ms);
  };
  await f.controller.tick();
  expect(f.calls).toEqual([
    "acquire",
    "build:b",
    "sleep:5000",
    "sleep:5000",
    "sleep:5000",
    "stop",
    "start:b",
  ]);
  expect(f.waits[0]).toMatchObject({
    status: "waiting_for_operations",
    deferred_operations: [{ kind: "mobile_signing", count: 1 }],
  });
  expect(f.records.at(-1)).toMatchObject({ status: "deployed" });
  expect(f.records.at(-1)).not.toHaveProperty("interrupted_operations");
});

test("C-609: the post-build wait is bounded and records the operations it interrupted", async () => {
  const g = fixture({ wait: 12_000 });
  g.driver.build = async (target) => {
    g.calls.push("build");
    g.setOps([signing]);
    return { build: { sha: target, release: "b" }, log_tail: "" };
  };
  await g.controller.tick();
  expect(g.calls).toEqual([
    "acquire",
    "build",
    "sleep:5000",
    "sleep:5000",
    "sleep:2000",
    "stop",
    "start:b",
  ]);
  expect(g.records.at(-1)).toMatchObject({
    status: "deployed",
    interrupted_operations: [{ kind: "mobile_signing", count: 1 }],
  });
  expect(g.detail.interrupted).toEqual([[signing]]);
});

test("C-609: a deadline already spent before the build is not granted again after it", async () => {
  const f = fixture({ wait: 60_000 });
  f.setOps([signing]);
  await f.controller.tick();
  f.advance(60_000);
  await f.controller.tick(); // deadline reached: proceeds, nothing left to wait
  expect(f.calls).toEqual(["acquire", "build:b", "stop", "start:b"]);
});

test("C-609: an unreadable operation registry or wait audit never holds a deployment", async () => {
  const f = fixture({ wait: 900_000, batch: 300_000 });
  f.driver.operations = async () => {
    throw new Error("registry unavailable");
  };
  f.driver.waitForOperations = async () => {
    throw new Error("audit unavailable");
  };
  await f.controller.tick();
  expect(f.current).toBe(sha("b"));
  f.setMain("c");
  f.advance(1_000);
  await f.controller.tick(); // batching audit failure is swallowed, still waits
  expect(f.current).toBe(sha("b"));
  f.advance(300_000);
  await f.controller.tick();
  expect(f.current).toBe(sha("c"));
});

test("C-609: drivers without the new hooks keep deploying immediately", async () => {
  const f = fixture();
  const legacy: DeploymentDriver = { ...f.driver };
  for (const key of [
    "batchWindowMs",
    "operationWaitMs",
    "operations",
    "fenceOperations",
    "releaseOperationFence",
    "waitForOperations",
    "sleep",
  ] as const)
    delete (legacy as Partial<Record<string, unknown>>)[key];
  legacy.stop = async () => {
    f.calls.push("stop");
  };
  const controller = new DeploymentController(legacy);
  await controller.tick();
  expect(f.calls).toEqual(["acquire", "build:b", "stop", "start:b"]);
});

test("C-609: an operation that starts after the last read but before the stop is waited for, not cut off", async () => {
  // Review V-3044: snapshot(0) → snapshot(0) → start → stop(live=1, audited=0).
  const f = fixture({ wait: 900_000 });
  const late: DeploymentOperation = {
    ...signing,
    id: "op-2",
    kind: "artifact_publication",
    label: "测试包外发",
  };
  let fences = 0;
  f.driver.fenceOperations = async () => {
    f.fence.up = true;
    // It registered just before the fence; the fence returns it atomically.
    return ++fences === 1 ? [late] : [];
  };
  await f.controller.tick();
  expect(f.calls).toEqual([
    "acquire",
    "build:b",
    "sleep:5000",
    "stop",
    "start:b",
  ]);
  expect(f.detail.waited).toEqual([[late]]);
  expect(f.detail.interrupted).toEqual([[]]);
  expect(f.records.at(-1)).not.toHaveProperty("interrupted_operations");
});

test("C-609: at the deadline the fence returns exactly what the stop interrupts", async () => {
  const f = fixture({ wait: 0 });
  const late: DeploymentOperation = {
    ...signing,
    id: "op-2",
    kind: "artifact_publication",
    label: "测试包外发",
  };
  // Nothing visible to the plain read; the fence sees the late start.
  f.driver.fenceOperations = async () => {
    f.fence.up = true;
    return [late];
  };
  await f.controller.tick();
  expect(f.calls).toEqual(["acquire", "build:b", "stop", "start:b"]);
  expect(f.detail.interrupted).toEqual([[late]]);
  expect(f.records.at(-1)).toMatchObject({
    interrupted_operations: [{ kind: "artifact_publication", count: 1 }],
  });
});

test("C-609: the fence is lifted when the attempt fails or rolls back", async () => {
  const f = fixture({ wait: 900_000 });
  let readies = 0;
  f.driver.ready = async () => ++readies > 1; // the new build never gets ready
  await f.controller.tick();
  expect(f.records.at(-1)?.status).toBe("rolled_back");
  expect(f.fence).toMatchObject({ up: false, taken: 1, released: 1 });
  const g = fixture({ wait: 900_000 });
  g.driver.fenceOperations = async () => {
    g.fence.up = true;
    throw new Error("registry unavailable");
  };
  await g.controller.tick();
  expect(g.records.at(-1)?.status).toBe("deployed");
  expect(g.fence).toMatchObject({ up: false, released: 1 });
});
