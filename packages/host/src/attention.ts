import type { ProjectId } from "@cardigan/domain";
import {
  pmMergeStallAttention,
  reviewLimitAttention,
  sessionMaintenanceNeedsAttention,
  sessionMaintenanceView,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import type { ReadRepositories, Store } from "@cardigan/store";
import {
  type ResourceWaitView,
  resourceWaits,
} from "./machine-reservations.js";
import { readRunQueue } from "./run-capacity.js";

/** Shared CLI attention / MCP diagnostics aggregation, read in one snapshot. */
export function readAttention(
  store: Store,
  project: ProjectId,
  now: string,
  transaction?: ReadRepositories,
) {
  const read = (tx: ReadRepositories) => {
    const state = loadCommandState(tx, project);
    return {
      session_maintenance: state.assignments
        .filter((a) => a.scope === "work_item" && a.status !== "released")
        .flatMap((a) => {
          const view = sessionMaintenanceView(state, a);
          return view && sessionMaintenanceNeedsAttention(view.reason)
            ? [{ assignment_id: a.id, ...view }]
            : [];
        }),
      attention: reviewLimitAttention(state, now),
      /** C-177: PM-held merge confirmations open past the stall threshold. */
      merge_stalls: pmMergeStallAttention(state, now),
      escalated: store
        .listNotifications({ project_id: project })
        .filter((n) =>
          ["needs_attention", "delivery_failed"].includes(n.status),
        ),
      lost: state.assignments.filter(
        (a) =>
          a.status === "active" &&
          ["lost", "unknown"].includes(a.runtime_state),
      ),
      paused: state.assignments.filter(
        (a) =>
          a.scope === "standing" &&
          a.role_id === "pm" &&
          a.status === "suspended",
      ),
      // C-800: why each queued Run waits; another project's reservation shows
      // only its holder project, source, window and reservation id.
      queued: (() => {
        const waits = resourceWaits(store.database, project);
        return readRunQueue(store, tx)
          .filter((r) => r.project_id === project)
          .map((r): typeof r & { resource_wait?: ResourceWaitView } => {
            const wait = waits.get(r.run_id);
            return wait ? { ...r, resource_wait: wait } : r;
          });
      })(),
      findings: store.listReconcileFindings(project, { openOnly: true }),
    };
  };
  return transaction ? read(transaction) : store.uow.read(read);
}
