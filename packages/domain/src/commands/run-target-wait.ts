import { assignmentCardHeld } from "../card-hold.js";
import type { Actor, Assignment, Run } from "../entities.js";
import type { RunId } from "../ids.js";
import { hasRunTarget } from "../run-target.js";
import {
  discussionWithdrawal,
  repairWakeTarget,
  reviewRunWakeDisposition,
} from "../shared-review-wake.js";
import { transition } from "../transitions.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  unwrap,
} from "./core.js";

export function dispatchTargetWaitMs(run: Run, now: string): number {
  const wait = run.dispatch_target_wait;
  return (
    (wait?.elapsed_ms ?? 0) +
    (wait?.since ? Math.max(0, Date.parse(now) - Date.parse(wait.since)) : 0)
  );
}

export function runTargetWaitReason(
  state: CommandState,
  owner: Assignment,
  run: Run,
) {
  if (
    run.status === "queued" &&
    assignmentCardHeld(owner, state, run.trigger_event_id)
  )
    return "card_held";
  if (!hasRunTarget(owner, state)) return "review_target_unavailable";
  if (reviewRunWakeDisposition(state, owner, run) === "paused")
    return "shared_review_paused";
  return undefined;
}

/** Recheck waits; only a positively withdrawn first repair can return to its queue. */
export function refreshRunTargetWait(
  state: CommandState,
  actor: Actor,
  p: {
    run_id: RunId;
    withdrawn_attempt_id?: string;
    no_transport_attempts?: true;
  },
  ports: CommandPorts,
) {
  return command(state, actor, "refresh_run_target_wait", ports, (d) => {
    const run = d.get("runs", p.run_id);
    const owner = d.get("assignments", run.assignment_id);
    const card =
      owner.scope === "work_item"
        ? d.get("work_items", owner.work_item_id).card_id
        : undefined;
    const reason = runTargetWaitReason(state, owner, run);
    if (p.withdrawn_attempt_id) {
      const target =
        reason === "shared_review_paused"
          ? repairWakeTarget(state, run)
          : undefined;
      d.emit("run_dispatch_deferred", card, {
        run_id: run.id,
        assignment_id: owner.id,
        attempt_id: p.withdrawn_attempt_id,
        reason: reason ?? "review_target_unavailable",
        ...(target
          ? { delivery_id: target.id, target_sha: target.subject.value }
          : {}),
      });
    }
    if (
      !["queued", "dispatched"].includes(run.status) ||
      run.started_at ||
      run.dispatch_stop ||
      run.inactivity_stop
    )
      return false;
    // Do not treat a dispatched Run as dormant. Only an exact pre-send
    // withdrawal and a fresh host check of transport history can return it
    // to the existing queue. Normal admission then owns its next send.
    const receipt =
      actor.kind === "system" &&
      p.no_transport_attempts &&
      reason === "shared_review_paused" &&
      discussionWithdrawal(state, owner, run);
    if (receipt) {
      const { bell_delivery: _address, ...queued } = run;
      d.put("runs", {
        ...queued,
        status: unwrap(transition("run", run.status, "launch_withdrawn")),
        queue_reason: "awaiting_dispatch",
        queue_entered_at: run.queue_entered_at ?? d.now,
        dispatch_target_wait: run.dispatch_target_wait ?? {
          since: d.now,
          elapsed_ms: 0,
        },
      });
      d.emit("run_pause_repair_requeued", card, {
        run_id: run.id,
        assignment_id: owner.id,
        withdrawal_event_id: receipt.id,
      });
      return true;
    }
    const waiting = reason !== undefined;
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
    // A superseded target also cannot be sent, but must not freeze the
    // recovery clock: ordinary fenced cleanup can retire the obsolete Run.
    return (
      waiting || reviewRunWakeDisposition(state, owner, run) === "obsolete"
    );
  });
}
