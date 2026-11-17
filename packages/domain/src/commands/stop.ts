import type { Actor, Assignment, Event, Run, RuntimeRef } from "../entities.js";
import type { Result } from "../errors.js";
import { hostOpsPending } from "../host-ops.js";
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
const ASSIGNMENT_STOP_RELEASED = "assignment_stop_released";

// One index per immutable event snapshot. Array order (not timestamps or
// per-card sequence numbers) remains the authority, exactly as in the scan.
const stoppedAssignments = new WeakMap<
  readonly Event[],
  ReadonlyMap<unknown, boolean>
>();

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
  let stopped = stoppedAssignments.get(events);
  if (!stopped) {
    const index = new Map<unknown, boolean>();
    for (const event of events)
      if (event.type === ASSIGNMENT_STOPPED || event.type === "run_dispatched")
        index.set(
          field(event.payload, "assignment_id"),
          event.type === ASSIGNMENT_STOPPED,
        );
    stopped = index;
    stoppedAssignments.set(events, stopped);
  }
  return stopped.get(assignment_id) ?? false;
}

const unfinished = (status: string) =>
  !["completed", "failed", "cancelled"].includes(status);

/**
 * `cardigan assignment stop` for a work-item Assignment, in two steps around
 * the terminal release.
 *
 * 1. Before the terminal is touched: record `assignment_stopped`, so the
 *    Dispatcher starts nothing for it from now on, and cancel its queued Runs
 *    (they hold no terminal and no run slot). Refused while a host operation
 *    is pending, so the two never leave each other unfinishable.
 * 2. With `released_runtime_ref`, once the host has released that terminal:
 *    cancel the remaining unfinished Runs, settle the runtime state and clear
 *    the ref. Until then the running Run keeps its run slot, so a failed
 *    release neither under-counts capacity nor loses the ref to retry with.
 *    A no-op when the stop no longer holds or the session changed.
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
    ensure(
      !hostOpsPending(state.events, a.id),
      "illegal_transition",
      `${a.id} 还有待处理的主机运维操作，等它处理完再停止；之后可以重新执行 cardigan assignment stop ${a.id}`,
    );
    const card = d.work(a.work_item_id).card_id;
    const cancel = (runs: readonly Run[]) => {
      for (const r of runs)
        d.put("runs", {
          ...r,
          status: unwrap(transition("run", r.status, "cancel")),
          outcome: "failed",
          summary: p.reason,
          finished_at: d.now,
        });
    };
    if (p.released_runtime_ref !== undefined) {
      if (
        !stoppedByHuman(state.events, a.id) ||
        JSON.stringify(a.runtime_ref) !== JSON.stringify(p.released_runtime_ref)
      )
        return { assignment: a, cancelled: 0 };
      const runs = d
        .list("runs")
        .filter((r) => r.assignment_id === a.id && unfinished(r.status));
      cancel(runs);
      // A later start launches from a clean runtime state, as after a restart.
      const runtime_state = ["unknown", "lost"].includes(a.runtime_state)
        ? unwrap(transition("runtime", a.runtime_state, "session_replaced"))
        : a.runtime_state === "running"
          ? unwrap(transition("runtime", a.runtime_state, "run_finished"))
          : a.runtime_state;
      const next = { ...a, runtime_state, runtime_ref: null };
      d.put("assignments", next);
      d.emit(ASSIGNMENT_STOP_RELEASED, card, {
        assignment_id: a.id,
        cancelled_run_ids: runs.map((r) => r.id),
      });
      return { assignment: next, cancelled: runs.length };
    }
    const queued = d
      .list("runs")
      .filter((r) => r.assignment_id === a.id && r.status === "queued");
    cancel(queued);
    d.emit(
      ASSIGNMENT_STOPPED,
      card,
      {
        assignment_id: a.id,
        cancelled_run_ids: queued.map((r) => r.id),
      },
      { type: "status_change", body: `Stopped ${a.id}` },
    );
    return { assignment: a, cancelled: queued.length };
  });
}
