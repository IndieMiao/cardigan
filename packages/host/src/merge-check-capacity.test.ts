import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { expect, test } from "vitest";
import { capacityMachine } from "./capacity-owner.js";
import {
  acquireDeploymentCapacity,
  reclaimMergeCheckCapacity,
  releaseDeploymentWait,
} from "./deployment-capacity.js";
import {
  acquireMergeCheckCapacity,
  executionOwner,
  mergeCheckCapacityAvailable,
  runningMergeChecks,
} from "./merge-check-capacity.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cg-capacity-"));
  const store = Store.open({ dataDir: root });
  store.createProject({ id: "fixture" });
  const owner = executionOwner(process.pid);
  if (!owner) throw new Error("Missing owner");
  return {
    store,
    root,
    owner,
    async close() {
      store.close();
      await rm(root, { force: true, recursive: true });
    },
  };
}

test("waiting deployment excludes new checks across connections while admitted checks can finish and transfer", async () => {
  const f = await fixture();
  const second = Store.open({ dataDir: f.root });
  try {
    const existing = acquireMergeCheckCapacity(f.store, "fixture", "existing");
    expect(acquireDeploymentCapacity(second)).toBeUndefined();
    expect(mergeCheckCapacityAvailable(f.store, "local", 10)).toBe(false);
    expect(() =>
      acquireMergeCheckCapacity(f.store, "fixture", "later"),
    ).toThrow(/Deployment/);
    existing.transfer(f.owner);
    existing();
    // Repeated admission attempts cannot win the gap before the deployment tick.
    expect(() =>
      acquireMergeCheckCapacity(f.store, "fixture", "later"),
    ).toThrow(/Deployment/);
    const deployment = acquireDeploymentCapacity(second);
    expect(deployment).toBeTypeOf("function");
    expect(() =>
      acquireMergeCheckCapacity(f.store, "fixture", "later"),
    ).toThrow(/Deployment/);
    deployment?.();
    acquireMergeCheckCapacity(f.store, "fixture", "later")();
    const check = acquireMergeCheckCapacity(f.store, "fixture", "pending");
    expect(acquireDeploymentCapacity(second)).toBeUndefined();
    releaseDeploymentWait(second);
    acquireMergeCheckCapacity(f.store, "fixture", "released-wait")();
    check();
  } finally {
    second.close();
    await f.close();
  }
});

test("reclaims only provably local dead incarnations; preserves foreign, legacy unknown and renewed owners", async () => {
  const f = await fixture();
  try {
    const boot = f.owner.start.split(":")[0];
    const add = (
      attempt: string,
      start: string,
      machine: string | null,
      pid = f.owner.pid,
    ) =>
      f.store.database
        .prepare(
          `INSERT INTO merge_check_capacity (project_id, attempt_id, machine_id, owner_pid, owner_start, owner_machine) VALUES ('fixture', ?, 'remote-target', ?, ?, ?)`,
        )
        .run(attempt, pid, start, machine);
    add("pid-reused", `${boot}:0`, capacityMachine());
    add("legacy-local", `${boot}:0`, null);
    add("missing-pid", f.owner.start, capacityMachine(), 2147483647);
    add(
      "prior-boot",
      "00000000-0000-0000-0000-000000000000:1",
      capacityMachine(),
    );
    add("legacy-foreign-boot", "00000000-0000-0000-0000-000000000000:1", null);
    add("foreign", `${boot}:0`, "other-machine");
    add("unknown", "unrecognized", capacityMachine());
    add("renewed", `${boot}:0`, capacityMachine());
    f.store.database
      .prepare(
        "UPDATE merge_check_capacity SET owner_start = ? WHERE attempt_id = 'renewed'",
      )
      .run(f.owner.start);
    f.store.uow.run(() => reclaimMergeCheckCapacity(f.store));
    f.store.uow.run(() => reclaimMergeCheckCapacity(f.store));
    expect(
      f.store.database
        .prepare(
          "SELECT attempt_id FROM merge_check_capacity ORDER BY attempt_id",
        )
        .all()
        .map((r) => r.attempt_id),
    ).toEqual(["foreign", "legacy-foreign-boot", "renewed", "unknown"]);
    expect(runningMergeChecks(f.store).get("remote-target")).toBe(4);
    expect(acquireDeploymentCapacity(f.store)).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("an early local release cannot delete a resumed lease for the same attempt", async () => {
  const f = await fixture();
  try {
    const original = acquireMergeCheckCapacity(f.store, "fixture", "attempt");
    original();
    const resumed = acquireMergeCheckCapacity(f.store, "fixture", "attempt");
    original();
    original.transfer(f.owner);
    expect(runningMergeChecks(f.store).get("local")).toBe(1);
    resumed();
    expect(runningMergeChecks(f.store).size).toBe(0);
  } finally {
    await f.close();
  }
});

test("supervisor ownership remains conservative across restart and legacy writes stay compatible", async () => {
  const f = await fixture();
  try {
    // The previous supervisor survives a server migration and writes three values.
    f.store.database
      .prepare("INSERT INTO host_deployment_capacity VALUES (1, ?, ?)")
      .run(f.owner.pid, f.owner.start);
    expect(acquireDeploymentCapacity(f.store)).toBeUndefined();
    expect(mergeCheckCapacityAvailable(f.store, "local", 1)).toBe(false);
    f.store.database.prepare("DELETE FROM host_deployment_capacity").run();
    f.store.database
      .prepare(
        "INSERT INTO host_deployment_waiter VALUES (1, ?, ?, ?, 'waiting')",
      )
      .run(f.owner.pid, f.owner.start, "foreign-machine");
    expect(acquireDeploymentCapacity(f.store)).toBeUndefined();
    releaseDeploymentWait(f.store);
    expect(mergeCheckCapacityAvailable(f.store, "local", 1)).toBe(false);
    f.store.database
      .prepare(
        "UPDATE host_deployment_waiter SET owner_machine = ?, owner_start = ?",
      )
      .run(capacityMachine(), `${f.owner.start.split(":")[0]}:0`);
    const deployment = acquireDeploymentCapacity(f.store);
    expect(deployment).toBeTypeOf("function");
    deployment?.();
    const newer = acquireDeploymentCapacity(f.store);
    deployment?.();
    expect(mergeCheckCapacityAvailable(f.store, "local", 1)).toBe(false);
    newer?.();
    expect(mergeCheckCapacityAvailable(f.store, "local", 1)).toBe(true);
  } finally {
    await f.close();
  }
});

test("check admission automatically reclaims its dead predecessor under the admission transaction", async () => {
  const f = await fixture();
  try {
    acquireMergeCheckCapacity(f.store, "fixture", "same-attempt");
    f.store.database
      .prepare("UPDATE merge_check_capacity SET owner_start = ?")
      .run(`${f.owner.start.split(":")[0]}:0`);
    const replacement = acquireMergeCheckCapacity(
      f.store,
      "fixture",
      "same-attempt",
    );
    expect(runningMergeChecks(f.store).get("local")).toBe(1);
    replacement();
  } finally {
    await f.close();
  }
});

test("a known previous-boot deployment can wait across ticks without losing its death evidence", async () => {
  const f = await fixture();
  try {
    const old = "00000000-0000-0000-0000-000000000000:1";
    f.store.database
      .prepare("INSERT INTO host_deployment_capacity VALUES (1, ?, ?)")
      .run(f.owner.pid, old);
    f.store.database
      .prepare("INSERT INTO host_deployment_waiter VALUES (1, ?, ?, ?, 'held')")
      .run(f.owner.pid, old, capacityMachine());
    const local = acquireMergeCheckCapacity(
      f.store,
      "fixture",
      "already-preparing",
    );
    expect(acquireDeploymentCapacity(f.store)).toBeUndefined();
    expect(acquireDeploymentCapacity(f.store)).toBeUndefined();
    local();
    const deployment = acquireDeploymentCapacity(f.store);
    expect(deployment).toBeTypeOf("function");
    deployment?.();
  } finally {
    await f.close();
  }
});
