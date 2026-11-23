import type {
  DeploymentDriver,
  DeploymentOperation,
  DeploymentRecord,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import { DeploymentController } from "./deployment.js";

const sha = (c: string) => c.repeat(40);
const signing: DeploymentOperation = {
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
    beforeStop: async (record) => {
      const stopping: DeploymentRecord = { ...record, status: "stopping" };
      records.push(stopping);
      return stopping;
    },
    stop: async () => {
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
    waitForOperations: async (record) => {
      waits.push(record);
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
    deferred_operations: [signing],
  });
  expect(f.waits[0]?.summary).toContain("sensen/C-14 受管送签（android）");
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
  expect(stopping).toMatchObject({ interrupted_operations: [signing] });
  expect(stopping?.summary).toContain("等待受管长操作已达上限，照常部署");
  expect(f.records.at(-1)).toMatchObject({
    status: "deployed",
    interrupted_operations: [signing],
  });
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
    deferred_operations: [signing],
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
    interrupted_operations: [signing],
  });
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
    "waitForOperations",
    "sleep",
  ] as const)
    delete (legacy as Partial<Record<string, unknown>>)[key];
  const controller = new DeploymentController(legacy);
  await controller.tick();
  expect(f.calls).toEqual(["acquire", "build:b", "stop", "start:b"]);
});
