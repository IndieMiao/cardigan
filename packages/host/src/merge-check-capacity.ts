import type { ProjectId } from "@cardigan/domain";
import {
  assertCheckAdmission,
  CheckAdmissionClosed,
  type CheckGrant,
  type Store,
} from "@cardigan/store";
import {
  type CapacityOwnerRow,
  capacityMachine,
  capacityOwnerState,
} from "./capacity-owner.js";
import {
  DeploymentInProgress,
  deploymentInProgress,
  reclaimMergeCheckCapacity,
} from "./deployment-capacity.js";
import { type ExecutionOwner, executionOwner } from "./process-identity.js";

export { type ExecutionOwner, executionOwner } from "./process-identity.js";

import { LOCAL_EXECUTOR } from "./merge-gate-executors.js";

/**
 * Reserve before starting an executor, transfer to its authenticated incarnation on ready,
 * and release after local execution settles (GitHub releases after durable binding).
 * `machine` is the execution target (P2a-12 D): `local` or a merge-gate executor name.
 */
export interface MergeCheckCapacityLease {
  (): void;
  transfer(owner?: ExecutionOwner): void;
}
export function acquireMergeCheckCapacity(
  store: Store,
  project: ProjectId,
  attempt: string,
  owner: ExecutionOwner | undefined = executionOwner(process.pid),
  machine: string = LOCAL_EXECUTOR,
  grant?: CheckGrant,
  limit?: number,
): MergeCheckCapacityLease {
  store.uow.run(() => {
    assertCheckAdmission(store, project, machine, grant);
    reclaimMergeCheckCapacity(store);
    if (deploymentInProgress(store)) throw new DeploymentInProgress();
    if (limit !== undefined && attemptRunning(store, project, attempt))
      throw new CheckAdmissionClosed();
    if (
      limit !== undefined &&
      (runningMergeChecks(store).get(machine) ?? 0) >= limit
    )
      throw new CheckAdmissionClosed();
    if (!owner) {
      if (limit !== undefined)
        throw new Error("Check execution owner unavailable");
      return;
    }
    store.database
      .prepare(`INSERT INTO merge_check_capacity
    (project_id, attempt_id, machine_id, owner_pid, owner_start, owner_machine) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        project,
        attempt,
        machine,
        owner.pid,
        owner.start,
        capacityMachine(),
      );
  });
  if (!owner) return Object.assign(() => {}, { transfer: () => {} });
  let current: ExecutionOwner = owner;
  const observer = capacityMachine();
  let released = false;
  const release = () => {
    if (released) return;
    store.uow.run(() => {
      store.database
        .prepare(`DELETE FROM merge_check_capacity
      WHERE project_id = ? AND attempt_id = ? AND owner_pid = ? AND owner_start = ? AND owner_machine = ?`)
        .run(project, attempt, current.pid, current.start, observer);
    });
    released = true;
  };
  return Object.assign(release, {
    transfer(next?: ExecutionOwner) {
      if (!next || released) return;
      store.uow.run(() => {
        if (grant) assertCheckAdmission(store, project, machine, grant);
        const changed = store.database
          .prepare(`UPDATE merge_check_capacity SET owner_pid = ?, owner_start = ?
          WHERE project_id = ? AND attempt_id = ? AND owner_pid = ? AND owner_start = ? AND owner_machine = ?`)
          .run(
            next.pid,
            next.start,
            project,
            attempt,
            current.pid,
            current.start,
            observer,
          );
        if (Number(changed.changes) !== 1)
          throw new Error("Merge capacity ownership changed");
      });
      current = next;
    },
  });
}

/**
 * Caller holds a read or write transaction. Live merge checks per execution
 * target, across all projects. Stale rows never reserve slots after restart.
 */
export function runningMergeChecks(store: Store): Map<string, number> {
  const rows = store.database
    .prepare(
      "SELECT machine_id, owner_pid, owner_start, owner_machine FROM merge_check_capacity",
    )
    .all();
  const running = new Map<string, number>();
  for (const row of rows) {
    if (capacityOwnerState(row as unknown as CapacityOwnerRow) === "dead")
      continue;
    const machine = String(row.machine_id);
    running.set(machine, (running.get(machine) ?? 0) + 1);
  }
  return running;
}

/** Whether a remote executor may start another check under its `max_concurrent`. */
export function mergeCheckCapacityAvailable(
  store: Store,
  machine: string,
  limit: number,
): boolean {
  return store.uow.read(
    () =>
      !deploymentInProgress(store) &&
      (runningMergeChecks(store).get(machine) ?? 0) < limit,
  );
}

function attemptRunning(
  store: Store,
  project: ProjectId,
  attempt: string,
): boolean {
  return store.database
    .prepare(
      "SELECT owner_pid,owner_start,owner_machine FROM merge_check_capacity WHERE project_id=? AND attempt_id=?",
    )
    .all(project, attempt)
    .some(
      (row) =>
        capacityOwnerState(row as unknown as CapacityOwnerRow) !== "dead",
    );
}
export function mergeCheckAttemptRunning(
  store: Store,
  project: ProjectId,
  attempt: string,
): boolean {
  return store.uow.read(() => attemptRunning(store, project, attempt));
}
