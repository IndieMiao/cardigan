import { assignmentCardHeld } from "../card-hold.js";
import type { Actor, Run } from "../entities.js";
import type { RunId } from "../ids.js";
import { hasRunTarget } from "../run-target.js";
import { type CommandPorts, type CommandState, command } from "./core.js";

export function dispatchTargetWaitMs(run: Run, now: string): number {
  const wait = run.dispatch_target_wait;
  return (
    (wait?.elapsed_ms ?? 0) +
    (wait?.since ? Math.max(0, Date.parse(now) - Date.parse(wait.since)) : 0)
  );
}

/** Recheck target waits without changing Run status, review budget or delivery history. */
export function refreshRunTargetWait(
  state: CommandState,
  actor: Actor,
  p: { run_id: RunId; withdrawn_attempt_id?: string },
  ports: CommandPorts,
) {
  return command(state, actor, "refresh_run_target_wait", ports, (d) => {
    const run = d.get("runs", p.run_id);
    const owner = d.get("assignments", run.assignment_id);
    const card =
      owner.scope === "work_item"
        ? d.get("work_items", owner.work_item_id).card_id
        : undefined;
    const held =
      run.status === "queued" &&
      assignmentCardHeld(owner, state, run.trigger_event_id);
    if (p.withdrawn_attempt_id)
      d.emit("run_dispatch_deferred", card, {
        run_id: run.id,
        assignment_id: owner.id,
        attempt_id: p.withdrawn_attempt_id,
        reason: held ? "card_held" : "review_target_unavailable",
      });
    if (
      !["queued", "dispatched"].includes(run.status) ||
      run.started_at ||
      run.dispatch_stop ||
      run.inactivity_stop
    )
      return false;
    const waiting = held || !hasRunTarget(owner, state);
    if (waiting && !run.dispatch_target_wait?.since) {
      d.put("runs", {
        ...run,
        dispatch_target_wait: {
          since: d.now,
          elapsed_ms: run.dispatch_target_wait?.elapsed_ms ?? 0,
        },
      });
      d.emit("run_target_wait_started", card, {
        run_id: run.id,
        assignment_id: owner.id,
      });
    } else if (!waiting && run.dispatch_target_wait?.since) {
      d.put("runs", {
        ...run,
        dispatch_target_wait: {
          elapsed_ms: dispatchTargetWaitMs(run, d.now),
        },
      });
      d.emit("run_target_wait_finished", card, {
        run_id: run.id,
        assignment_id: owner.id,
      });
    }
    return waiting;
  });
}
