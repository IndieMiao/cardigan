import {
  autoAssignVerifier,
  type Clock,
  type ProjectId,
  remindSystemWaits,
} from "@cardigan/domain";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import type { StateLoader } from "./dispatch-state.js";

/** Run before routing: successful assignment sends the delivery straight to its owner. */
export function runSystemRules(
  store: Store,
  project: ProjectId,
  clock: Clock,
  loadState: StateLoader = loadCommandState,
) {
  store.uow.run((tx) => {
    const actor = { kind: "system" as const, project_id: project };
    const ports = { clock, ids: tx.ids };
    let state = loadState(tx, project);
    if (
      state.project_preferences?.find((p) => p.id === project)
        ?.system_auto_assign_verifiers === true
    ) {
      for (const item of state.work_items) {
        if (item.kind !== "verify" || item.assignment_id || item.manual_assign)
          continue;
        const result = autoAssignVerifier(
          state,
          actor,
          { work_item_id: item.id },
          ports,
        );
        if (!result.ok) throw new Error(result.error.message);
        persistEffect(tx, project, result.value);
        if (result.value.events.length || result.value.changes.length)
          state = loadState(tx, project);
      }
    }
    const reminders = remindSystemWaits(state, actor, ports);
    if (!reminders.ok) throw new Error(reminders.error.message);
    persistEffect(tx, project, reminders.value);
  });
}
