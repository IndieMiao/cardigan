import type { Assignment, Event, Run, RuntimeRef } from "./entities.js";
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
  readonly process?: NonNullable<Run["launch_publication"]>["process"];
  readonly run_ids?: readonly string[];
  readonly backup?: WorkerRecoveryBackup;
};

const lossCache = new WeakMap<readonly Event[], readonly RemoteWorkerLoss[]>();
export function remoteWorkerLosses(
  events: readonly Event[],
): readonly RemoteWorkerLoss[] {
  let losses = lossCache.get(events);
  if (!losses) {
    const corrected = new Set(
      events
        .filter(
          (e) =>
            e.type === "remote_worker_loss_corrected" &&
            ["human", "system"].includes(e.actor.kind),
        )
        .map((e) => (e.payload as { action_id: string }).action_id),
    );
    losses = events
      .filter(
        (e) =>
          e.type === "remote_worker_lost" &&
          e.actor.kind === "system" &&
          !corrected.has(e.id),
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
  const last = events.findLast(
    (e) =>
      e.actor.kind === "system" &&
      (e.payload as { action_id?: string }).action_id === loss.action_id &&
      ["remote_worker_alive", "remote_worker_exit_observed"].includes(e.type),
  );
  if (
    last?.type === "remote_worker_alive" &&
    (last.payload as { after_release?: boolean }).after_release
  )
    return true;
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
