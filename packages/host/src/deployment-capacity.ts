import type { Store } from "@cardigan/store";
import { type ExecutionOwner, executionOwner } from "./process-identity.js";

/** Caller holds the SQLite transaction. Dead incarnations never keep a fence. */
export function deploymentInProgress(store: Store): boolean {
  const row = store.database
    .prepare(
      "SELECT owner_pid, owner_start FROM host_deployment_capacity WHERE singleton = 1",
    )
    .get();
  return (
    !!row && executionOwner(Number(row.owner_pid))?.start === row.owner_start
  );
}

export class DeploymentInProgress extends Error {
  constructor() {
    super("Deployment is in progress");
  }
}

/** Atomic with merge-check admission, across all projects and host processes. */
export function acquireDeploymentCapacity(
  store: Store,
  owner: ExecutionOwner | undefined = executionOwner(process.pid),
) {
  if (!owner) throw new Error("Deployment process identity unavailable");
  const acquired = store.uow.run(() => {
    if (
      deploymentInProgress(store) ||
      store.database
        .prepare("SELECT owner_pid, owner_start FROM merge_check_capacity")
        .all()
        .some(
          (row) =>
            executionOwner(Number(row.owner_pid))?.start === row.owner_start,
        )
    )
      return false;
    store.database
      .prepare(
        "INSERT OR REPLACE INTO host_deployment_capacity VALUES (1, ?, ?)",
      )
      .run(owner.pid, owner.start);
    return true;
  });
  if (!acquired) return undefined;
  return () =>
    store.uow.run(() => {
      store.database
        .prepare(
          "DELETE FROM host_deployment_capacity WHERE singleton = 1 AND owner_pid = ? AND owner_start = ?",
        )
        .run(owner.pid, owner.start);
    });
}
