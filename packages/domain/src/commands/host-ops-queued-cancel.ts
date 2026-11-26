import type { Actor, Run } from "../entities.js";
import { hostOpsPending } from "../host-ops.js";
import type { RunId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
  unwrap,
} from "./core.js";
import { untouchedQueuedRun } from "./idle-session-retirement.js";

/**
 * C-759: whether `host_ops_cancel_run` may cancel this Run directly, without
 * stopping any terminal: a work-item Run that is queued and untouched (never
 * started, no bell, launch, dispatch or stop in flight). Such a Run holds no
 * terminal, so the Assignment's live session, if any, is left as it is.
 */
export function directlyCancellableRun(state: CommandState, run: Run) {
  const a = state.assignments.find((v) => v.id === run.assignment_id);
  return (
    !!a &&
    a.scope === "work_item" &&
    a.status === "active" &&
    !a.role_upgrade &&
    untouchedQueuedRun(run) &&
    !hostOpsPending(state.events, a.id)
  );
}

/**
 * C-759: a host operator cancels a queued, never-started Run directly. The
 * terminal and session of its Assignment are not touched (a previous turn's
 * session may still be live); only this Run is cancelled, recorded with the
 * operator's reason as `host_ops_action_taken` (not an execution intent) and
 * on the card timeline. A started Run keeps the guarded stop path.
 */
export function cancelQueuedHostOpsRun(
  state: CommandState,
  actor: Actor,
  p: { readonly run_id: RunId; readonly reason: string },
  ports: CommandPorts,
) {
  return command(state, actor, "host_ops_cancel_run", ports, (d) => {
    text(p.reason, "reason");
    ensure(
      actor.kind === "assignment",
      "unauthorized",
      "Host operations tools require an authenticated host_ops Assignment",
    );
    ensure(
      !hostOpsPending(state.events, actor.assignment_id),
      "illegal_transition",
      "The operator has a pending session operation",
    );
    const run = d.get("runs", p.run_id);
    ensure(
      directlyCancellableRun(state, run),
      "illegal_transition",
      "Run is not a queued Run that never started",
    );
    const a = d.get("assignments", run.assignment_id);
    // directlyCancellableRun admits work-item Assignments only.
    const card = d.work(a.work_item_id!).card_id;
    const reason = p.reason.trim();
    d.put("runs", {
      ...run,
      status: unwrap(transition("run", run.status, "cancel")),
      outcome: "failed",
      summary: `cancelled by host operations (${actor.assignment_id}): ${reason}`,
      finished_at: d.now,
    });
    const body = `主机运维 ${actor.assignment_id} 取消了排队中、尚未开始的 ${run.id}（${a.id}）：${reason}。未触碰终端，现有会话不受影响。`;
    d.emit(
      "host_ops_action_taken",
      card,
      {
        tool: "host_ops_cancel_run",
        target_id: run.id,
        assignment_id: a.id,
        run_id: run.id,
        reason,
        result: "queued_run_cancelled",
      },
      { type: "system", body, run_id: run.id },
    );
    return {
      assignment_id: a.id,
      run_id: run.id,
      result: "queued_run_cancelled" as const,
      message: "已取消排队中、尚未开始的 Run；没有触碰终端，现有会话不受影响。",
    };
  });
}
