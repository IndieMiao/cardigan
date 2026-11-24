import { heldStandingRun, standingRunDormant } from "../card-hold.js";
import type { Actor, Assignment, Run } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import { hostOpsPending } from "../host-ops.js";
import { type CommandPorts, type CommandState, command } from "./core.js";
import { restartStandingSession } from "./standing.js";

const payload = (e: CommandState["events"][number]) =>
  e.payload as Record<string, unknown>;
export function pmRecoveryEligible(
  state: CommandState,
  a: Assignment,
): boolean {
  if (
    a.scope !== "standing" ||
    a.role_id !== "pm" ||
    a.standing_mode !== "ops" ||
    a.status !== "active" ||
    a.external ||
    hostOpsPending(state.events, a.id) ||
    state.assignments.filter(
      (v) =>
        v.scope === "standing" &&
        v.role_id === "pm" &&
        v.standing_mode === "ops" &&
        v.status === "active",
    ).length !== 1
  )
    return false;
  const runs = state.runs.filter((r) => r.assignment_id === a.id);
  if (
    runs.some(
      (r) =>
        r.dispatch_stop ||
        r.inactivity_stop ||
        (r.launch_publication &&
          !["started", "exited"].includes(r.launch_publication.phase)) ||
        ["dispatched", "acked"].includes(r.status) ||
        (r.status === "queued" && !standingRunDormant(a, r)),
    )
  )
    return false;
  const executing = runs.some((r) => ["running", "unknown"].includes(r.status));
  // Pure queued work is not execution, and by itself is not a reason to restart.
  // Both the host observation entry and transactional settlement use this gate.
  if (!executing && runs.some((r) => standingRunDormant(a, r))) return false;
  if (
    executing &&
    (!a.runtime_ref || !["lost", "unknown"].includes(a.runtime_state))
  )
    return false;
  const previous = state.events.findLast(
    (e) =>
      e.type === "standing_pm_recovered" &&
      e.actor.kind === "system" &&
      payload(e).assignment_id === a.id,
  );
  // One recovery until an actual new run starts: failed launches cannot spin.
  return (
    !previous ||
    eventsOfType(state.events, "run_started").some(
      (e) =>
        payload(e).assignment_id === a.id && e.seq > previous.seq && !e.card_id,
    )
  );
}

/** Private host observation, never an Agent tool or a lease-based exit inference. */
export function recoverStandingPm(
  state: CommandState,
  actor: Actor,
  p: {
    assignment: Assignment;
    runs: readonly Run[];
    /** Hold state captured before observing the exact session's exit. */
    held_run_ids: readonly Run["id"][];
    exited: boolean;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "recover_standing_pm", ports, (d) => {
    const a = d.get("assignments", p.assignment.id);
    const runs = state.runs.filter((r) => r.assignment_id === a.id);
    if (
      !p.exited ||
      !pmRecoveryEligible(state, a) ||
      JSON.stringify(a) !== JSON.stringify(p.assignment) ||
      JSON.stringify(runs) !== JSON.stringify(p.runs) ||
      JSON.stringify(
        runs.filter((r) => heldStandingRun(a, r, state)).map((r) => r.id),
      ) !== JSON.stringify(p.held_run_ids)
    )
      return false;
    // Confirmed exit settles actual execution, never the dormant queue that
    // must retain its identity even when its source card has resumed.
    restartStandingSession(d, a.id, p.assignment.runtime_ref, true);
    d.emit("standing_pm_recovered", undefined, {
      assignment_id: a.id,
      notice:
        "常驻 PM 没有有效会话，系统已确认旧终端退出并安排自动重开；待办和原授权保持，实际恢复以新执行开始为准。",
      old_runtime_ref: a.runtime_ref ? { ...a.runtime_ref } : null,
    });
    return true;
  });
}
