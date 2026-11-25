import type { Store } from "@cardigan/store";
import {
  type CapacityOwnerRow,
  capacityMachine,
  capacityOwnerState,
} from "./capacity-owner.js";
import { maintenanceActive } from "./deployment-maintenance.js";
import { type ExecutionOwner, executionOwner } from "./process-identity.js";

function activeFence(store: Store) {
  return store.database
    .prepare(`SELECT active.owner_pid, active.owner_start, owner.owner_machine
    FROM host_deployment_capacity AS active LEFT JOIN host_deployment_waiter AS owner
    ON owner.singleton = active.singleton AND owner.owner_pid = active.owner_pid
    AND owner.owner_start = active.owner_start AND owner.phase = 'held'
    WHERE active.singleton = 1`)
    .get() as CapacityOwnerRow | undefined;
}
function waitingFence(store: Store) {
  return store.database
    .prepare(`SELECT owner_pid, owner_start, owner_machine
    FROM host_deployment_waiter WHERE singleton = 1 AND phase = 'waiting'`)
    .get() as CapacityOwnerRow | undefined;
}

function occupied(row: CapacityOwnerRow | undefined) {
  return !!row && capacityOwnerState(row) !== "dead";
}

/**
 * Caller holds the transaction. Pending deployment also closes new admission;
 * so does an open host maintenance window (C-390).
 */
export function deploymentInProgress(store: Store): boolean {
  return (
    occupied(activeFence(store)) ||
    occupied(waitingFence(store)) ||
    maintenanceActive(store)
  );
}

/** Only the deployment fence itself, without the maintenance window. */
export function deploymentFenceOccupied(store: Store): boolean {
  return occupied(activeFence(store)) || occupied(waitingFence(store));
}

export class DeploymentInProgress extends Error {
  constructor() {
    super("Deployment is in progress or waiting for capacity");
  }
}

/** Caller holds the write transaction. Never changes the remote execution journal. */
export function reclaimMergeCheckCapacity(store: Store): void {
  const rows = store.database
    .prepare("SELECT * FROM merge_check_capacity")
    .all() as unknown as (CapacityOwnerRow & {
    project_id: string;
    attempt_id: string;
  })[];
  for (const row of rows) {
    if (capacityOwnerState(row) !== "dead") continue;
    store.database
      .prepare(`DELETE FROM merge_check_capacity WHERE project_id = ? AND attempt_id = ?
        AND owner_pid = ? AND owner_start = ? AND owner_machine IS ?`)
      .run(
        row.project_id,
        row.attempt_id,
        row.owner_pid,
        row.owner_start,
        row.owner_machine,
      );
  }
}

export function releaseDeploymentWait(
  store: Store,
  owner = executionOwner(process.pid),
): void {
  if (!owner) return;
  store.uow.run(() => {
    store.database
      .prepare(`DELETE FROM host_deployment_waiter WHERE singleton = 1
      AND owner_pid = ? AND owner_start = ? AND owner_machine = ? AND phase = 'waiting'`)
      .run(owner.pid, owner.start, capacityMachine());
  });
}

/** Atomic waiter registration, stale reclamation and acquisition with check admission. */
export function acquireDeploymentCapacity(
  store: Store,
  owner: ExecutionOwner | undefined = executionOwner(process.pid),
) {
  if (!owner) throw new Error("Deployment process identity unavailable");
  const machine = capacityMachine();
  const acquired = store.uow.run(() => {
    const active = activeFence(store);
    if (occupied(active)) return false;
    // Retire the proven-dead legacy row before replacing its observer metadata.
    // Otherwise a wait could leave an old-boot row with no local identity proof.
    if (active)
      store.database
        .prepare(`DELETE FROM host_deployment_capacity
      WHERE singleton = 1 AND owner_pid = ? AND owner_start = ?`)
        .run(active.owner_pid, active.owner_start);
    const waiter = waitingFence(store);
    if (
      occupied(waiter) &&
      !(
        waiter?.owner_pid === owner.pid &&
        waiter.owner_start === owner.start &&
        waiter.owner_machine === machine
      )
    )
      return false;
    store.database
      .prepare(
        "INSERT OR REPLACE INTO host_deployment_waiter VALUES (1, ?, ?, ?, 'waiting')",
      )
      .run(owner.pid, owner.start, machine);
    reclaimMergeCheckCapacity(store);
    if (
      store.database.prepare("SELECT 1 FROM merge_check_capacity LIMIT 1").get()
    )
      return false;
    store.database
      .prepare(`INSERT OR REPLACE INTO host_deployment_capacity
      (singleton, owner_pid, owner_start) VALUES (1, ?, ?)`)
      .run(owner.pid, owner.start);
    store.database
      .prepare(
        "UPDATE host_deployment_waiter SET phase = 'held' WHERE singleton = 1",
      )
      .run();
    return true;
  });
  if (!acquired) return undefined;
  let released = false;
  return () => {
    if (released) return;
    store.uow.run(() => {
      store.database
        .prepare(`DELETE FROM host_deployment_capacity WHERE singleton = 1
      AND owner_pid = ? AND owner_start = ?`)
        .run(owner.pid, owner.start);
      store.database
        .prepare(`DELETE FROM host_deployment_waiter WHERE singleton = 1
        AND owner_pid = ? AND owner_start = ? AND owner_machine = ? AND phase = 'held'`)
        .run(owner.pid, owner.start, machine);
    });
    released = true;
  };
}
