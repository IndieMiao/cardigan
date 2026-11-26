import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  fixture as cardFixture,
  human,
  id,
} from "../../domain/src/commands/test-fixtures.js";
import {
  writeDeferredOperations,
  writeInterruptedOperations,
  writeOperationWait,
} from "./deployment-audit.js";
import { parseDeploymentConfig } from "./deployment-config.js";
import {
  fenceLongOperations,
  holdLongOperation,
  keepUntilSettled,
  LONG_OPERATION_FENCE_MAX_MS,
  liveLongOperations,
  longOperationFenceStands,
  releaseLongOperationFence,
  releaseSettlingHold,
  tryHoldLongOperation,
  withLongOperation,
} from "./long-operations.js";
import { executionOwner } from "./process-identity.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cg-long-ops-"));
  const store = Store.open({ dataDir: root, dbPath: ":memory:" });
  store.createProject({ id: "cardigan" });
  return {
    store,
    /** A card in another project than the deployment's own. */
    foreignCard() {
      const project = human.project_id;
      store.createProject({ id: project });
      store.uow.run((tx) => {
        for (const c of cardFixture().cards) tx.cards.put(project, c);
      });
      return { project, card: id("card", 1) as string };
    },
    async close() {
      store.close();
      await rm(root, { force: true, recursive: true });
    },
  };
}

const signing = {
  kind: "mobile_signing" as const,
  project_id: "sensen",
  card_id: "C-14",
  label: "受管送签（android）",
};

const settled = async <T>(promise: Promise<T>) => {
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await delay(30);
  return done;
};

test("C-609: a held operation is listed until released; release is idempotent", async () => {
  const f = await fixture();
  try {
    const release = await holdLongOperation(f.store, signing, {
      now: () => "2026-11-23T01:00:00.000Z",
    });
    expect(liveLongOperations(f.store)).toMatchObject([
      { ...signing, started_at: "2026-11-23T01:00:00.000Z" },
    ]);
    release();
    release();
    expect(liveLongOperations(f.store)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("C-609: withLongOperation releases after a rejection too", async () => {
  const f = await fixture();
  try {
    let during: number | undefined;
    await expect(
      withLongOperation(
        f.store,
        { ...signing, kind: "artifact_publication", label: "测试包外发" },
        async () => {
          during = liveLongOperations(f.store).length;
          throw new Error("upload failed");
        },
      ),
    ).rejects.toThrow("upload failed");
    expect(during).toBe(1);
    expect(liveLongOperations(f.store)).toEqual([]);
  } finally {
    await f.close();
  }
});

test("C-609: a proven-dead owner never delays a deployment and its row is reclaimed", async () => {
  const f = await fixture();
  try {
    const owner = executionOwner(process.pid);
    if (!owner) throw new Error("Missing owner");
    const boot = owner.start.split(":")[0];
    // Same PID, different incarnation: the earlier server process has exited.
    await holdLongOperation(
      f.store,
      { kind: "worker_upgrade", project_id: "cardigan", label: "worker 升级" },
      { owner: { pid: process.pid, start: `${boot}:1` } },
    );
    expect(liveLongOperations(f.store)).toEqual([]);
    const left = f.store.database
      .prepare("SELECT COUNT(*) AS n FROM host_long_operations")
      .get() as { n: number };
    expect(Number(left.n)).toBe(0);
  } finally {
    await f.close();
  }
});

test("C-609: an owner on another machine stays listed (cannot be proven dead)", async () => {
  const f = await fixture();
  try {
    await holdLongOperation(f.store, { ...signing, label: "受管送签（ios）" });
    f.store.database
      .prepare("UPDATE host_long_operations SET owner_machine = ?")
      .run("0".repeat(64));
    expect(liveLongOperations(f.store)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("C-609: an older schema without the registry neither fails the operation nor the wait", async () => {
  const f = await fixture();
  try {
    f.store.database.exec("DROP TABLE host_long_operations");
    f.store.database.exec("DROP TABLE host_long_operation_fence");
    const release = await holdLongOperation(f.store, signing);
    expect(liveLongOperations(f.store)).toEqual([]);
    expect(fenceLongOperations(f.store)).toEqual([]);
    expect(() => releaseLongOperationFence(f.store)).not.toThrow();
    expect(() => release()).not.toThrow();
  } finally {
    await f.close();
  }
});

test("C-609: the stop fence and the last read are one step; a later start waits for the next server", async () => {
  const f = await fixture();
  try {
    const before = await holdLongOperation(f.store, signing);
    // The deployment decides to stop: whatever runs now is what it interrupts.
    expect(fenceLongOperations(f.store)).toMatchObject([signing]);
    // A publication requested after that decision does not start here.
    const later = holdLongOperation(
      f.store,
      {
        kind: "artifact_publication",
        project_id: "sensen",
        card_id: "C-15",
        label: "测试包外发",
      },
      { pollMs: 5 },
    );
    expect(await settled(later)).toBe(false);
    expect(liveLongOperations(f.store)).toMatchObject([signing]);
    before();
    expect(await settled(later)).toBe(false);
    // The deployment ends (new server ready, or rolled back): starts reopen.
    releaseLongOperationFence(f.store);
    const release = await later;
    expect(liveLongOperations(f.store)).toMatchObject([{ card_id: "C-15" }]);
    release();
  } finally {
    await f.close();
  }
});

test("C-609: a fence never stops operations for good", async () => {
  const f = await fixture();
  try {
    const owner = executionOwner(process.pid);
    if (!owner) throw new Error("Missing owner");
    const boot = owner.start.split(":")[0];
    // Its supervisor has exited: the fence no longer holds anything.
    fenceLongOperations(f.store, { pid: process.pid, start: `${boot}:1` });
    (await holdLongOperation(f.store, signing))();
    // Owner alive but the fence is older than the limit.
    const old = new Date(Date.now() - LONG_OPERATION_FENCE_MAX_MS - 1000);
    fenceLongOperations(f.store, owner, () => old.toISOString());
    (await holdLongOperation(f.store, signing))();
    expect(
      f.store.database
        .prepare("SELECT COUNT(*) AS n FROM host_long_operation_fence")
        .get(),
    ).toMatchObject({ n: 0 });
    // Only the fence's own owner reopens it.
    fenceLongOperations(f.store, owner);
    releaseLongOperationFence(f.store, { pid: process.pid, start: "other" });
    expect(
      await settled(holdLongOperation(f.store, signing, { pollMs: 5 })),
    ).toBe(false);
    releaseLongOperationFence(f.store, owner);
  } finally {
    await f.close();
  }
});

test("C-609: a worker upgrade's hold lasts until the journal settles the job", async () => {
  const f = await fixture();
  try {
    const release = await holdLongOperation(f.store, {
      kind: "worker_upgrade",
      project_id: "cardigan",
      label: "worker 升级（mac-mini）",
    });
    keepUntilSettled("job-1", release);
    expect(liveLongOperations(f.store)).toHaveLength(1);
    releaseSettlingHold("job-2");
    expect(liveLongOperations(f.store)).toHaveLength(1);
    releaseSettlingHold("job-1");
    releaseSettlingHold("job-1");
    expect(liveLongOperations(f.store)).toEqual([]);
  } finally {
    await f.close();
  }
});

const record = {
  attempt: "attempt-1",
  from: "a".repeat(40),
  to: "b".repeat(40),
  status: "waiting_for_operations" as const,
  build: "not_run" as const,
  ready: false,
  downtime_ms: 0,
  summary: "等待受管长操作结束或到达可续点后再部署",
};
const op = {
  id: "op-1",
  kind: "mobile_signing",
  project_id: "cardigan",
  card_id: "C-1",
  label: "受管送签（android）",
  started_at: "2026-11-23T01:00:00.000Z",
};

function deploymentEvents(store: Store) {
  return store.uow.read((tx) =>
    tx.events
      .listAfter("cardigan", undefined, 0)
      .filter((e) => e.type === "host_deployment_recorded"),
  );
}

test("C-609: an operation wait is audited once per distinct situation, without notices", async () => {
  const f = await fixture();
  try {
    const counts = [{ kind: "mobile_signing", count: 1 }];
    writeOperationWait(f.store, "cardigan", {
      ...record,
      deferred_operations: counts,
    });
    writeOperationWait(f.store, "cardigan", {
      ...record,
      attempt: "attempt-2",
      deferred_operations: counts,
    });
    writeOperationWait(f.store, "cardigan", {
      ...record,
      attempt: "attempt-3",
      deferred_operations: [],
    });
    const events = deploymentEvents(f.store);
    expect(events).toHaveLength(2);
    expect(
      events.map((e) => (e.payload as { attempt: string }).attempt),
    ).toEqual(["attempt-1", "attempt-1"]);
    expect(events[0]?.payload).toMatchObject({ deferred_operations: counts });
    expect(f.store.uow.read((tx) => tx.human_actions.list("cardigan"))).toEqual(
      [],
    );
    expect(() =>
      writeOperationWait(f.store, "cardigan", { ...record, status: "started" }),
    ).toThrow();
  } finally {
    await f.close();
  }
});

test.each([
  [
    "interrupted",
    writeInterruptedOperations,
    "host_deployment_operation_interrupted",
    "重启后续跑或重排",
  ],
  [
    "deferred",
    writeDeferredOperations,
    "host_deployment_operation_deferred",
    "结束后再重启服务端",
  ],
] as const)(
  "C-609: a %s operation leaves one timeline note on its own card",
  async (_, write, type, text) => {
    const f = await fixture();
    try {
      const { project, card } = f.foreignCard();
      write(f.store, "attempt-1", [
        { ...op, project_id: project, card_id: card },
        { ...op, project_id: project, card_id: "C-999" },
        { ...op, project_id: project, card_id: null },
      ]);
      const timeline = f.store.uow.read((tx) => tx.timeline.list(project));
      expect(timeline).toHaveLength(1);
      expect(timeline[0]).toMatchObject({ card_id: card, type: "system" });
      expect(timeline[0]?.body).toContain("受管送签（android）");
      expect(timeline[0]?.body).toContain(text);
      const events = f.store.uow.read((tx) =>
        tx.events.listAfter(project, card, 0),
      );
      expect(events.map((e) => e.type)).toEqual([type]);
      // Nothing lands in the deployment project.
      expect(f.store.uow.read((tx) => tx.timeline.list("cardigan"))).toEqual(
        [],
      );
    } finally {
      await f.close();
    }
  },
);

test("C-609: the Node driver keeps other projects' card detail out of the deployment project", async () => {
  const f = await fixture();
  try {
    const { project, card } = f.foreignCard();
    const { NodeDeploymentDriver } = await import("./deployment-node.js");
    const driver = new NodeDeploymentDriver({
      store: f.store,
      dataDir: tmpdir(),
      config: parseDeploymentConfig({
        initial_release: tmpdir(),
        initial_sha: "a".repeat(40),
        ready_timeout_ms: 1000,
        stop_timeout_ms: 1000,
        poll_interval_ms: 1000,
        build_timeout_ms: 1000,
      }),
      env: {},
    });
    expect(driver.batchWindowMs).toBe(300000);
    expect(driver.operationWaitMs).toBe(900000);
    const release = await holdLongOperation(
      f.store,
      {
        kind: "artifact_publication",
        project_id: project,
        card_id: card,
        label: "测试包外发",
      },
      { now: () => "2026-11-23T01:00:00.000Z" },
    );
    const ops = await driver.operations();
    expect(ops).toMatchObject([
      {
        kind: "artifact_publication",
        project_id: project,
        card_id: card,
        label: "测试包外发",
        started_at: "2026-11-23T01:00:00.000Z",
      },
    ]);
    const counts = [{ kind: "artifact_publication", count: 1 }];
    for (let i = 0; i < 3; i++)
      await driver.waitForOperations(
        {
          ...record,
          summary: `tick ${i}`,
          deferred_operations: counts,
        },
        ops,
      );
    expect(deploymentEvents(f.store)).toHaveLength(1);
    // The fence is taken at the stop decision and returns the same detail.
    expect(await driver.fenceOperations()).toEqual(ops);
    await driver.beforeStop(
      {
        ...record,
        status: "started",
        build: "passed",
        interrupted_operations: counts,
      },
      ops,
    );
    await driver.releaseOperationFence();
    const projectStream = JSON.stringify(
      f.store.uow.read((tx) => [
        tx.events.listAfter("cardigan", undefined, 0),
        tx.timeline.list("cardigan"),
      ]),
    );
    expect(projectStream).not.toContain(project);
    expect(projectStream).not.toContain(card);
    expect(projectStream).not.toContain("测试包外发");
    expect(projectStream).toContain('"count":1');
    // The source card has its own record of the wait and the interruption.
    const notes = f.store.uow.read((tx) =>
      tx.events
        .listAfter(project as never, card as never, 0)
        .map((e) => e.type),
    );
    expect(notes).toEqual([
      "host_deployment_operation_deferred",
      "host_deployment_operation_interrupted",
    ]);
    release();
    expect(await driver.operations()).toEqual([]);
  } finally {
    await f.close();
  }
});

test("C-799: trying to hold never waits: refused while a fence stands, registered otherwise", async () => {
  const f = await fixture();
  try {
    const step = {
      kind: "merge_step" as const,
      project_id: "cardigan",
      card_id: "C-7",
      label: "合并 C-7 的「同步源仓库」",
    };
    expect(longOperationFenceStands(f.store)).toBe(false);
    const release = tryHoldLongOperation(f.store, step);
    expect(release).toBeTypeOf("function");
    // The fence reads it in the same transaction that closes new starts.
    expect(fenceLongOperations(f.store)).toMatchObject([step]);
    expect(longOperationFenceStands(f.store)).toBe(true);
    expect(tryHoldLongOperation(f.store, step)).toBeUndefined();
    release?.();
    release?.();
    expect(liveLongOperations(f.store)).toEqual([]);
    // An expired fence no longer refuses (and is retired by the next writer).
    expect(
      longOperationFenceStands(
        f.store,
        Date.now() + LONG_OPERATION_FENCE_MAX_MS + 1,
      ),
    ).toBe(false);
    releaseLongOperationFence(f.store);
    expect(longOperationFenceStands(f.store)).toBe(false);
    const again = tryHoldLongOperation(f.store, step);
    expect(liveLongOperations(f.store)).toHaveLength(1);
    again?.();
    // No identity or table: best effort, never throws, never refuses.
    f.store.database.exec("DROP TABLE host_long_operation_fence");
    expect(longOperationFenceStands(f.store)).toBe(false);
  } finally {
    await f.close();
  }
});
