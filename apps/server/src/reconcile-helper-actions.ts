import {
  completeVerifiedHelperAction,
  matchesOpenHelperAction,
  streamEventsBy,
} from "@cardigan/domain";
import { manualUpgradeKey, tryHelperConfirmationLock } from "@cardigan/host";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import type { ReadRepositories } from "@cardigan/store";
import type { MachineChecks } from "./web/machine-checks.js";

export async function reconcileHelperActions(
  checks: MachineChecks,
  project: string,
  machine: string,
) {
  const { store, clock } = checks;
  const binding = store.uow.read((tx) =>
    checks.currentBinding(project, tx.machines.get(project, machine)),
  );
  if (!binding) return;
  const target = {
    machine_id: machine,
    binding,
    key: manualUpgradeKey(machine),
  };
  const origins = (tx: ReadRepositories) => ({
    project_id: project,
    // Only these requests identify a helper action (`workerHelperAction`).
    events: streamEventsBy(tx.events, project, undefined, "type", [
      "host_deployment_action_requested",
    ]),
  });
  const candidates = store.uow.read((tx) => {
    const open = tx.human_actions
      .list(project)
      .filter(
        (h) =>
          h.status === "open" &&
          h.requested_by === "system" &&
          !h.card_id &&
          (!h.helper_upgrade || h.helper_upgrade.machine_id === machine),
      );
    if (!open.length) return [];
    const state = origins(tx);
    return open.filter((h) => matchesOpenHelperAction(state, h, target));
  });
  for (const { id } of candidates) {
    // Never hold up the other machines while a Workbench confirmation is running.
    const release = await tryHelperConfirmationLock(store, project, id);
    if (!release) continue;
    try {
      const open = store.uow.read((tx) => {
        const h = tx.human_actions.get(project, id);
        return h && matchesOpenHelperAction(origins(tx), h, target);
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
