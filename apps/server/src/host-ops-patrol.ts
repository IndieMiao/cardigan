import {
  type Clock,
  eventsOfType,
  hostOpsPending,
  type ProjectId,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import { recordNotification, type Store } from "@cardigan/store";
import type { StateLoader } from "./dispatch-state.js";

export const DEFAULT_HOST_OPS_PATROL_INTERVAL_MS = 30 * 60_000;
/** Uses the dispatcher clock and inbox; no extra timer and no run-finished self wake. */
export function patrolHostOps(
  store: Store,
  project: ProjectId,
  clock: Clock,
  intervalMs = DEFAULT_HOST_OPS_PATROL_INTERVAL_MS,
  loadState: StateLoader = loadCommandState,
) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0)
    throw new Error("Invalid host ops patrol interval");
  store.uow.run((tx) => {
    const state = loadState(tx, project);
    const a = state.assignments.find(
      (a) =>
        a.scope === "standing" &&
        a.role_id === "host_ops" &&
        a.status === "active",
    );
    if (!a || hostOpsPending(state.events, a.id)) return;
    const last =
      eventsOfType(state.events, "host_ops_patrol_due").findLast(
        (e) => (e.payload as { assignment_id?: string }).assignment_id === a.id,
      )?.created_at ?? a.created_at;
    if (
      Date.parse(clock.now()) - Date.parse(last) < intervalMs ||
      state.runs.some(
        (r) =>
          r.assignment_id === a.id &&
          !["completed", "failed", "cancelled"].includes(r.status),
      )
    )
      return;
    if (
      store
        .listNotifications({ project_id: project })
        .some(
          (n) =>
            n.recipient.kind === "assignment" &&
            n.recipient.assignment_id === a.id &&
            ["pending", "belled", "delivery_failed"].includes(n.status),
        )
    )
      return;
    const event = {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project),
      type: "host_ops_patrol_due",
      actor: { kind: "system" as const, project_id: project },
      payload: { assignment_id: a.id },
      created_at: clock.now(),
    };
    tx.events.append(project, event);
    recordNotification(store.database, {
      project_id: project,
      event_id: event.id,
      seq: event.seq,
      kind: "assignment",
      at: event.created_at,
      recipient: { kind: "assignment", assignment_id: a.id },
    });
  });
}
