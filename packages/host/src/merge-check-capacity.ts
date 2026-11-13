import type { ProjectId } from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import {
  DeploymentInProgress,
  deploymentInProgress,
} from "./deployment-capacity.js";
import { type ExecutionOwner, executionOwner } from "./process-identity.js";

export { type ExecutionOwner, executionOwner } from "./process-identity.js";

import { LOCAL_EXECUTOR } from "./merge-gate-executors.js";

/**
 * Reserve before starting an executor, transfer to its authenticated incarnation on ready,
 * and release only after it settles (even on errors).
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
): MergeCheckCapacityLease {
  if (!owner) return Object.assign(() => {}, { transfer: () => {} });
  let current = owner;
  store.uow.run(() => {
    if (deploymentInProgress(store)) throw new DeploymentInProgress();
    store.database
      .prepare(`INSERT INTO merge_check_capacity
    (project_id, attempt_id, machine_id, owner_pid, owner_start) VALUES (?, ?, ?, ?, ?)`)
      .run(project, attempt, machine, owner.pid, owner.start);
  });
  const release = () =>
    store.uow.run(() => {
      store.database
        .prepare(`DELETE FROM merge_check_capacity
      WHERE project_id = ? AND attempt_id = ? AND owner_pid = ? AND owner_start = ?`)
        .run(project, attempt, current.pid, current.start);
    });
  return Object.assign(release, {
    transfer(next?: ExecutionOwner) {
      if (!next) return;
      store.uow.run(() => {
        const changed = store.database
          .prepare(`UPDATE merge_check_capacity SET owner_pid = ?, owner_start = ?
          WHERE project_id = ? AND attempt_id = ? AND owner_pid = ? AND owner_start = ?`)
          .run(
            next.pid,
            next.start,
            project,
            attempt,
            current.pid,
            current.start,
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
      "SELECT machine_id, owner_pid, owner_start FROM merge_check_capacity",
    )
    .all();
  const running = new Map<string, number>();
  for (const row of rows) {
    if (executionOwner(Number(row.owner_pid))?.start !== row.owner_start)
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
