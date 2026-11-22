import { lstatSync } from "node:fs";
import { join } from "node:path";
import { workerJournalId } from "./worker-onboarding.js";

// The enrollment key is never put into runtime config, a runtime ref, CLI output or a Run.
export function upgradeIdentity(
  configRoot: string,
  project: string,
  machine: string,
) {
  workerJournalId(project, machine);
  // Length prefix keeps the tuple unambiguous even when both IDs contain separators.
  return join(
    configRoot,
    `upgrade-${machine.length}-${machine}-${project}.key`,
  );
}

export function enrolledUpgradeIdentity(
  root: string,
  project: string,
  machine: string,
) {
  const identity = upgradeIdentity(root, project, machine);
  const active = [identity, `${identity}.bound`].filter((path) =>
    lstatSync(path, { throwIfNoEntry: false }),
  );
  if (active.length > 1) throw new Error("worker_upgrade_enrollment_conflict");
  return active[0];
}

// Only a confirmed absence selects the manual route. Presence (even a broken
// link) is not authorization to install: the transport still verifies the key.
export function manualWorkerUpgradeAllowed(
  root: string,
  project: string,
  machine: string,
) {
  try {
    return enrolledUpgradeIdentity(root, project, machine) === undefined;
  } catch {
    return false;
  }
}
