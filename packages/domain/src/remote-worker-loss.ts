import type { Assignment, Event, Run, RuntimeRef } from "./entities.js";
import { eventsOfType, eventsOfTypes } from "./event-index.js";
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
    // C-671: type lookups, so losses on closed cards count in `slim` too.
    const corrected = new Set(
      eventsOfType(events, "remote_worker_loss_corrected")
        .filter((e) => ["human", "system"].includes(e.actor.kind))
        .map((e) => (e.payload as { action_id: string }).action_id),
    );
    losses = eventsOfType(events, "remote_worker_lost")
      .filter((e) => e.actor.kind === "system" && !corrected.has(e.id))
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
  return eventsOfType(events, "remote_worker_released").some(
    (e) =>
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
  all: readonly Event[],
  loss: RemoteWorkerLoss,
) {
  // C-671: only these types take part; their relative order is history order.
  const events = eventsOfTypes(all, [
    "human_action_requested",
    "remote_worker_alive",
    "remote_worker_exit_observed",
    "human_action_completed",
  ]);
  const request = events.findLastIndex(
    (e) =>
      e.type === "human_action_requested" &&
      e.actor.kind === "system" &&
      (e.payload as { host_ops_action_id?: string }).host_ops_action_id ===
        loss.action_id,
  );
  if (request < 0) return true;
  const id = (
    events[request]?.payload as { human_action_id?: string } | undefined
  )?.human_action_id;
  const last = events.findLastIndex(
    (e) =>
      e.actor.kind === "system" &&
      (e.payload as { action_id?: string }).action_id === loss.action_id &&
      ["remote_worker_alive", "remote_worker_exit_observed"].includes(e.type),
  );
  const observation = events[last];
  // Before structured conclusions, an after-release sighting could open a new H.
  // Only that later request and its own human completion settle that observation.
  if (
    observation?.type === "remote_worker_alive" &&
    (observation.payload as { after_release?: boolean }).after_release &&
    last >= request
  )
    return true;
  return (
    !id ||
    !events.some(
      (e, i) =>
        i > request &&
        e.type === "human_action_completed" &&
        e.actor.kind === "human" &&
        [undefined, "exited"].includes(
          (e.payload as { conclusion?: string }).conclusion,
        ) &&
        (e.payload as { human_action_id?: string }).human_action_id === id,
    )
  );
}
