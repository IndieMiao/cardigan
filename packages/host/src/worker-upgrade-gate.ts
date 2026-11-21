import type { Store } from "@cardigan/store";
import { workerHelperDigests } from "./worker-helper-release.js";

export const upgradeHold = "worker_helper_upgrade_unverified";
export const upgradeKey = (fingerprint: string | undefined) =>
  `${fingerprint}:${Object.values(workerHelperDigests()).join(":")}`;
export function upgradeState(store: Store, project: string, machine: string) {
  return store.database
    .prepare(
      "SELECT release_key,state FROM worker_helper_upgrades WHERE project_id=? AND machine_id=?",
    )
    .get(project, machine);
}
export function upgradeHeld(store: Store, project: string, machine: string) {
  const row = upgradeState(store, project, machine);
  return !!row && row.state !== "verified";
}
// A fresh explicit worker check permits read-only recovery, never a reinstall.
export function manualWorkerChecked(
  store: Store,
  project: string,
  machine: string,
  fingerprint: string,
) {
  store.uow.run(() =>
    store.database
      .prepare(
        "UPDATE worker_helper_upgrades SET state='worker_checked' WHERE project_id=? AND machine_id=? AND release_key=? AND state='failed'",
      )
      .run(project, machine, upgradeKey(fingerprint)),
  );
}
export function manualMachineChecked(
  store: Store,
  project: string,
  machine: string,
  fingerprint: string | undefined,
) {
  store.uow.run((tx) => {
    const recovered = store.database
      .prepare(
        "UPDATE worker_helper_upgrades SET state='verified' WHERE project_id=? AND machine_id=? AND release_key=? AND state='worker_checked'",
      )
      .run(project, machine, upgradeKey(fingerprint));
    if (recovered.changes)
      tx.events.append(project, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project),
        created_at: new Date().toISOString(),
        type: "worker_helper_upgrade_recovered",
        actor: { kind: "system", project_id: project },
        payload: {
          machine_id: machine,
          expected: { ...workerHelperDigests() },
        },
      });
  });
}
