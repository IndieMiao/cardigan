import type { CommandState } from "./commands/core.js";
import type { HumanAction } from "./entities.js";
import { eventsOfType } from "./event-index.js";

/** The original system request (not editable instructions) identifies pre-upgrade rows. */
export function workerHelperAction(
  state: Pick<CommandState, "project_id" | "events">,
  action: HumanAction,
) {
  if (action.requested_by !== "system" || action.card_id) return undefined;
  const request = eventsOfType(
    state.events,
    "host_deployment_action_requested",
  ).findLast((e) => {
    const p = e.payload as {
      key?: string;
      human_action_id?: string;
      reason?: string;
    };
    return (
      e.actor.kind === "system" &&
      e.actor.project_id === state.project_id &&
      !e.card_id &&
      p.reason === "worker_maintenance" &&
      p.human_action_id === action.id &&
      typeof p.key === "string" &&
      p.key.startsWith("worker-helper:")
    );
  });
  if (!request && !action.helper_upgrade) return undefined;
  const key = request && (request.payload as { key: string }).key;
  const machine =
    key &&
    /^worker-helper:([a-zA-Z0-9][a-zA-Z0-9._-]*)(?::[0-9a-f]{64}){3}$/u.exec(
      key,
    )?.[1];
  // An unidentifiable system notice is still fenced; never guess its target.
  return {
    key,
    machine_id:
      machine &&
      (!action.helper_upgrade || machine === action.helper_upgrade.machine_id)
        ? machine
        : null,
  };
}

export function matchesOpenHelperAction(
  state: Pick<CommandState, "project_id" | "events">,
  action: HumanAction,
  target: { machine_id: string; key: string; binding: string },
) {
  if (
    action.status !== "open" ||
    !target.binding ||
    (action.helper_upgrade && action.helper_upgrade.binding !== target.binding)
  )
    return false;
  const origin = workerHelperAction(state, action);
  return origin?.machine_id === target.machine_id && origin.key === target.key;
}
