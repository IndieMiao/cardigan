import type { Actor, Assignment } from "../entities.js";
import type { Result } from "../errors.js";
import type { AssignmentId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  type CommandDraft,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { handoffWithoutOps } from "./delegation.js";

function standing(d: CommandDraft, id: AssignmentId) {
  ensure(
    d.actor.kind === "human",
    "unauthorized",
    "Only the human can pause or resume a standing PM",
  );
  const a = d.get("assignments", id);
  ensure(
    a.scope === "standing" && a.role_id === "pm",
    "unauthorized",
    "Only standing PM assignments can be paused here",
  );
  return a;
}
/** Host command: persist the spending boundary before touching the external runtime. */
export function pauseStandingAssignment(
  state: CommandState,
  actor: Actor,
  p: { assignment_id: AssignmentId },
  ports: CommandPorts,
): Result<CommandEffect<{ assignment: Assignment; aborted: boolean }>> {
  return command(state, actor, "pause_standing_assignment", ports, (d) => {
    const a = standing(d, p.assignment_id);
    if (a.status === "suspended") {
      handoffWithoutOps(d, a);
      return { assignment: a, aborted: false };
    }
    const status = unwrap(transition("assignment", a.status, "suspend"));
    const runs = d
      .list("runs")
      .filter(
        (r) =>
          r.assignment_id === a.id &&
          !["completed", "failed", "cancelled"].includes(r.status),
      );
    for (const r of runs)
      d.put("runs", {
        ...r,
        status: unwrap(transition("run", r.status, "cancel")),
        outcome: "failed",
        summary: "Standing PM paused by human",
        finished_at: d.now,
      });
    const next = {
      ...a,
      status,
      runtime_state:
        a.runtime_state === "running"
          ? unwrap(transition("runtime", a.runtime_state, "run_finished"))
          : a.runtime_state,
    };
    d.put("assignments", next);
    d.emit("assignment_paused", undefined, {
      assignment_id: a.id,
      cancelled_run_ids: runs.map((r) => r.id),
    });
    handoffWithoutOps(d, next);
    return { assignment: next, aborted: runs.length > 0 };
  });
}
/** Called inside queueRun so resuming and reserving the new Run are atomic. */
export function resumeStanding(d: CommandDraft, id: AssignmentId): void {
  const a = standing(d, id);
  const status = unwrap(transition("assignment", a.status, "resume"));
  const { session_ref: _oldSession, ...rest } = a;
  const runtime_state = ["unknown", "lost"].includes(a.runtime_state)
    ? unwrap(transition("runtime", a.runtime_state, "session_replaced"))
    : a.runtime_state;
  d.put("assignments", { ...rest, status, runtime_state, runtime_ref: null });
  d.emit("assignment_resumed", undefined, {
    assignment_id: a.id,
    old_runtime_ref: a.runtime_ref ? { ...a.runtime_ref } : null,
    handoff:
      "常驻 PM 由人恢复。读取排队门铃对应的 get_updates，再 ack_events；配置与会话历史保留在原 Assignment 运行目录。",
  });
}
