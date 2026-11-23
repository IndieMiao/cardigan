import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import {
  fixture as cardFixture,
  human,
  id,
} from "../../domain/src/commands/test-fixtures.js";
import {
  writeInterruptedOperations,
  writeOperationWait,
} from "./deployment-audit.js";
import { parseDeploymentConfig } from "./deployment-config.js";
import {
  holdLongOperation,
  liveLongOperations,
  withLongOperation,
} from "./long-operations.js";
import { executionOwner } from "./process-identity.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cg-long-ops-"));
  const store = Store.open({ dataDir: root, dbPath: ":memory:" });
  store.createProject({ id: "cardigan" });
  return {
    store,
    async close() {
      store.close();
      await rm(root, { force: true, recursive: true });
    },
  };
}

test("C-609: a held operation is listed until released; release is idempotent", async () => {
  const f = await fixture();
  try {
    const release = holdLongOperation(
      f.store,
      {
        kind: "mobile_signing",
        project_id: "sensen",
        card_id: "C-14",
        label: "受管送签（android）",
      },
      { now: () => "2026-11-23T01:00:00.000Z" },
    );
    expect(liveLongOperations(f.store)).toMatchObject([
      {
        kind: "mobile_signing",
        project_id: "sensen",
        card_id: "C-14",
        label: "受管送签（android）",
        started_at: "2026-11-23T01:00:00.000Z",
      },
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
        {
          kind: "artifact_publication",
          project_id: "sensen",
          card_id: "C-14",
          label: "测试包外发",
        },
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
    holdLongOperation(
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
    holdLongOperation(f.store, {
      kind: "mobile_signing",
      project_id: "sensen",
      label: "受管送签（ios）",
    });
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
    const release = holdLongOperation(f.store, {
      kind: "mobile_signing",
      project_id: "sensen",
      label: "受管送签（android）",
    });
    expect(liveLongOperations(f.store)).toEqual([]);
    expect(() => release()).not.toThrow();
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
    writeOperationWait(f.store, "cardigan", {
      ...record,
      deferred_operations: [op],
    });
    writeOperationWait(f.store, "cardigan", {
      ...record,
      attempt: "attempt-2",
      deferred_operations: [op],
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
    expect(events[0]?.payload).toMatchObject({ deferred_operations: [op] });
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

test("C-609: an interrupted operation leaves one timeline note on its own card", async () => {
  const f = await fixture();
  try {
    const project = human.project_id;
    const card = id("card", 1);
    f.store.createProject({ id: project });
    f.store.uow.run((tx) => {
      for (const c of cardFixture().cards) tx.cards.put(project, c);
    });
    writeInterruptedOperations(f.store, {
      ...record,
      status: "stopping",
      interrupted_operations: [
        { ...op, project_id: project, card_id: card },
        { ...op, project_id: project, card_id: "C-999" },
        { ...op, project_id: project, card_id: null },
      ],
    });
    const timeline = f.store.uow.read((tx) => tx.timeline.list(project));
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({ card_id: card, type: "system" });
    expect(timeline[0]?.body).toContain("受管送签（android）");
    expect(timeline[0]?.body).toContain("重启后续跑或重排");
    const events = f.store.uow.read((tx) =>
      tx.events.listAfter(project, card, 0),
    );
    expect(events.map((e) => e.type)).toEqual([
      "host_deployment_operation_interrupted",
    ]);
  } finally {
    await f.close();
  }
});

test("C-609: the Node driver reads held operations and audits each distinct wait once", async () => {
  const f = await fixture();
  try {
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
    const release = holdLongOperation(
      f.store,
      {
        kind: "artifact_publication",
        project_id: "cardigan",
        card_id: "C-1",
        label: "测试包外发",
      },
      { now: () => "2026-11-23T01:00:00.000Z" },
    );
    const ops = await driver.operations();
    expect(ops).toEqual([
      {
        kind: "artifact_publication",
        project_id: "cardigan",
        card_id: "C-1",
        label: "测试包外发",
        started_at: "2026-11-23T01:00:00.000Z",
      },
    ]);
    for (let i = 0; i < 3; i++)
      await driver.waitForOperations({
        ...record,
        summary: `tick ${i}`,
        deferred_operations: ops,
      });
    expect(deploymentEvents(f.store)).toHaveLength(1);
    release();
    expect(await driver.operations()).toEqual([]);
  } finally {
    await f.close();
  }
});
