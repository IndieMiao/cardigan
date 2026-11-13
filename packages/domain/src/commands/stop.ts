import type { Actor, Assignment, Event, RuntimeRef } from "../entities.js";
import type { Result } from "../errors.js";
import type { AssignmentId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";

const ASSIGNMENT_STOPPED = "assignment_stopped";

const field = (payload: unknown, key: string): unknown =>
  payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>)[key]
    : undefined;

/**
 * C-211: a work-item Assignment the human stopped stays stopped until the
 * human starts it again. The latest of its `assignment_stopped` and
 * `run_dispatched` events decides: the Dispatcher does not wake, replace or
 * start a session for it in between (new bells stay pending), and host_ops
 * cannot restart it either.
 */
export function stoppedByHuman(
  events: readonly Event[],
  assignment_id: AssignmentId,
): boolean {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as Event;
    if (
      (event.type === ASSIGNMENT_STOPPED || event.type === "run_dispatched") &&
      field(event.payload, "assignment_id") === assignment_id
    )
      return event.type === ASSIGNMENT_STOPPED;
  }
  return false;
}

/**
 * `cardigan assignment stop` for a work-item Assignment, persisted before the
 * terminal is touched: cancel every unfinished Run of it (queued ones too, so
 * none is dispatched later) and record the stop. The RuntimeRef is kept so a
 * failed terminal release can be retried; once the host has released that
 * terminal it calls again with `released_runtime_ref` to clear it.
 */
export function stopWorkItemAssignment(
  state: CommandState,
  actor: Actor,
  p: {
    assignment_id: AssignmentId;
    reason: string;
    released_runtime_ref?: RuntimeRef;
  },
  ports: CommandPorts,
): Result<CommandEffect<{ assignment: Assignment; cancelled: number }>> {
  return command(state, actor, "stop_assignment", ports, (d) => {
    ensure(
      actor.kind === "human",
      "unauthorized",
      "Only the human can stop an Assignment",
    );
    const a = d.get("assignments", p.assignment_id);
    ensure(
      a.scope === "work_item",
      "illegal_transition",
      "Standing PM assignments are paused, not stopped",
    );
    ensure(
      a.status === "active",
      "illegal_transition",
      `Assignment ${a.id} is ${a.status}`,
    );
    if (p.released_runtime_ref !== undefined) {
      // Only the terminal this stop released; a session started since wins.
      if (
        JSON.stringify(a.runtime_ref) !== JSON.stringify(p.released_runtime_ref)
      )
        return { assignment: a, cancelled: 0 };
      const next = { ...a, runtime_ref: null };
      d.put("assignments", next);
      return { assignment: next, cancelled: 0 };
    }
    const runs = d
      .list("runs")
      .filter(
        (r) =>
          r.assignment_id === a.id &&
          !["completed", "failed", "cancelled"].includes(r.status),
      );
    for (const r of runs) {
      d.put("runs", {
        ...r,
        status: unwrap(transition("run", r.status, "cancel")),
        outcome: "failed",
        summary: p.reason,
        finished_at: d.now,
      });
    }
    // A later start launches from a clean runtime state, as after a restart.
    const runtime_state = ["unknown", "lost"].includes(a.runtime_state)
      ? unwrap(transition("runtime", a.runtime_state, "session_replaced"))
      : a.runtime_state === "running"
        ? unwrap(transition("runtime", a.runtime_state, "run_finished"))
        : a.runtime_state;
    const next = { ...a, runtime_state };
    d.put("assignments", next);
    d.emit(
      ASSIGNMENT_STOPPED,
      d.work(a.work_item_id).card_id,
      {
        assignment_id: a.id,
        cancelled_run_ids: runs.map((r) => r.id),
      },
      { type: "status_change", body: `Stopped ${a.id}` },
    );
    return { assignment: next, cancelled: runs.length };
  });
}
