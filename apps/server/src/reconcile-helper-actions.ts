import {
  completeVerifiedHelperAction,
  matchesOpenHelperAction,
  streamEventsBy,
  workerHelperAction,
} from "@cardigan/domain";
import { manualUpgradeKey, tryHelperConfirmationLock } from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import type { ReadRepositories } from "@cardigan/store";
import type { MachineChecks } from "./web/machine-checks.js";

const origins = (tx: ReadRepositories, project: string) => ({
  project_id: project,
  // Only these requests identify a helper action (`workerHelperAction`).
  events: streamEventsBy(tx.events, project, undefined, "type", [
    "host_deployment_action_requested",
  ]),
});
const systemHelperActions = (tx: ReadRepositories, project: string) =>
  tx.human_actions
    .list(project)
    .filter((h) => h.requested_by === "system" && !h.card_id);

/** This project's open upgrade confirmations for its own current binding. */
function openHelperActions(
  checks: MachineChecks,
  project: string,
  machine: string,
) {
  const { store } = checks;
  const binding = store.uow.read((tx) =>
    checks.currentBinding(project, tx.machines.get(project, machine)),
  );
  if (!binding) return null;
  const target = {
    machine_id: machine,
    binding,
    key: manualUpgradeKey(machine),
  };
  const candidates = store.uow.read((tx) => {
    const open = systemHelperActions(tx, project).filter(
      (h) =>
        h.status === "open" &&
        (!h.helper_upgrade || h.helper_upgrade.machine_id === machine),
    );
    if (!open.length) return [];
    const state = origins(tx, project);
    return open.filter((h) => matchesOpenHelperAction(state, h, target));
  });
  return { binding, target, candidates };
}

/** Whether a patrol of this project and machine could close an open confirmation. */
export function hasOpenHelperAction(
  checks: MachineChecks,
  project: string,
  machine: string,
) {
  return !!openHelperActions(checks, project, machine)?.candidates.length;
}

/**
 * C-764: the newest time another project registering the same physical machine
 * confirmed the current helper release on it (both of its own fresh checks
 * passed). Only a hint to schedule this project's own checks; never evidence.
 */
export function siblingHelperConfirmedAt(
  checks: MachineChecks,
  project: string,
  machine: string,
) {
  const key = manualUpgradeKey(machine);
  const passed = (r: { status: string; failed_steps: readonly string[] }) =>
    r.status === "passed" && !r.failed_steps.length;
  let latest: string | null = null;
  for (const other of checks.store.listProjects()) {
    if (other.id === project) continue;
    checks.store.uow.read((tx) => {
      if (!tx.machines.get(other.id, machine)) return;
      const confirmed = systemHelperActions(tx, other.id).filter(
        (h) =>
          h.status === "done" &&
          h.helper_checks &&
          passed(h.helper_checks.worker) &&
          passed(h.helper_checks.machine),
      );
      if (!confirmed.length) return;
      const state = origins(tx, other.id);
      for (const h of confirmed) {
        const origin = workerHelperAction(state, h);
        const at = h.helper_checks?.at;
        if (
          at &&
          origin?.machine_id === machine &&
          origin.key === key &&
          (latest === null || Date.parse(at) > Date.parse(latest))
        )
          latest = at;
      }
    });
  }
  return latest;
}

export async function reconcileHelperActions(
  checks: MachineChecks,
  project: string,
  machine: string,
) {
  const { store, clock } = checks;
  const found = openHelperActions(checks, project, machine);
  if (!found) return;
  const { binding, target, candidates } = found;
  for (const { id } of candidates) {
    // Never hold up the other machines while a Workbench confirmation is running.
    const release = await tryHelperConfirmationLock(store, project, id);
    if (!release) continue;
    try {
      const open = store.uow.read((tx) => {
        const h = tx.human_actions.get(project, id);
        return h && matchesOpenHelperAction(origins(tx, project), h, target);
      });
      if (!open) continue;
      await checks.verifyHelper(project, machine, binding, {
        onVerified(tx, results) {
          persistEffect(
            tx,
            project,
            unwrap(
              completeVerifiedHelperAction(
                loadCommandState(tx, project),
                { kind: "system", project_id: project },
                { ...target, human_action_id: id, checks: results },
                { ids: tx.ids, clock },
              ),
            ),
          );
        },
      });
    } finally {
      await release();
    }
  }
}
