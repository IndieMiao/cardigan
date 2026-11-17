import type { Assignment, Event, RuntimeRef } from "./entities.js";
import type {
  AssignmentId,
  EventId,
  HumanActionId,
  WorkItemId,
} from "./ids.js";

/** Host-recorded last successful backup; never supplied by an Agent. */
export type WorkerRecoveryBackup = NonNullable<
  NonNullable<Assignment["recovery"]>["backup"]
>;
export type RemoteWorkerLoss = {
  readonly action_id: EventId;
  readonly assignment_id: AssignmentId;
  readonly work_item_id: WorkItemId;
  readonly machine_id: string;
  readonly runtime_ref: RuntimeRef | null;
  readonly backup?: WorkerRecoveryBackup;
};

const lossCache = new WeakMap<readonly Event[], readonly RemoteWorkerLoss[]>();
export function remoteWorkerLosses(
  events: readonly Event[],
): readonly RemoteWorkerLoss[] {
  let losses = lossCache.get(events);
  if (!losses) {
    losses = events
      .filter(
        (e) => e.type === "remote_worker_lost" && e.actor.kind === "system",
      )
      .map((e) => ({
        ...(e.payload as unknown as RemoteWorkerLoss),
        action_id: e.id,
      }));
    lossCache.set(events, losses);
  }
  return losses;
}

export function remoteWorkerLossReleased(
  events: readonly Event[],
  action_id: EventId,
) {
  return events.some(
    (e) =>
      e.type === "remote_worker_released" &&
      e.actor.kind === "system" &&
      (e.payload as { action_id?: string }).action_id === action_id,
  );
}

export function remoteExitAction(
  state: { readonly events: readonly Event[] },
  id: HumanActionId,
) {
  return state.events.some(
    (e) =>
      e.type === "human_action_requested" &&
      (e.payload as { human_action_id?: string }).human_action_id === id &&
      state.events.some(
        (intent) =>
          ["remote_worker_lost", "remote_worker_alive"].includes(intent.type) &&
          intent.id ===
            (e.payload as { host_ops_action_id?: string }).host_ops_action_id,
      ),
  );
}

/** A newer request supersedes earlier exit evidence, including after a late alive observation. */
export function remoteWorkerExitPending(
  events: readonly Event[],
  loss: RemoteWorkerLoss,
) {
  const request = events.findLast(
    (e) =>
      e.type === "human_action_requested" &&
      (e.payload as { host_ops_action_id?: string }).host_ops_action_id ===
        loss.action_id,
  );
  const id = (request?.payload as { human_action_id?: string } | undefined)
    ?.human_action_id;
  return (
    !id ||
    !events.some(
      (e) =>
        e.type === "human_action_completed" &&
        e.actor.kind === "human" &&
        (e.payload as { human_action_id?: string }).human_action_id === id,
    )
  );
}
