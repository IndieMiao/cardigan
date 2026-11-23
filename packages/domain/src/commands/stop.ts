import type { Actor, Assignment, Event, Run, RuntimeRef } from "../entities.js";
import type { Result } from "../errors.js";
import { hostOpsPending } from "../host-ops.js";
import type { AssignmentId } from "../ids.js";
import { retirementWaitReceipt } from "../retirement-session.js";
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

/**
 * C-620: `held` is an explicit human pause (and every legacy stop without a
 * `hold` field). `stopping` is a managed stop whose terminal release is not
 * confirmed yet; once released it no longer fences dispatch, so new work
 * starts a fresh session automatically.
 */
type StopState = "held" | "stopping" | "released";
interface StopIndex {
  readonly state: ReadonlyMap<unknown, StopState>;
  /** Latest of a stop (any kind) and `run_dispatched` is the stop. */
  readonly recorded: ReadonlyMap<unknown, boolean>;
}
// One index per immutable event snapshot. Array order (not timestamps or
// per-card sequence numbers) remains the authority, exactly as in the scan.
const stoppedAssignments = new WeakMap<readonly Event[], StopIndex>();

const field = (payload: unknown, key: string): unknown =>
  payload !== null && typeof payload === "object"
    ? (payload as Record<string, unknown>)[key]
    : undefined;

function stopIndex(events: readonly Event[]): StopIndex {
  let index = stoppedAssignments.get(events);
  if (!index) {
    const state = new Map<unknown, StopState>();
    const recorded = new Map<unknown, boolean>();
    for (const event of events) {
      const id = field(event.payload, "assignment_id");
      if (event.type === ASSIGNMENT_STOPPED) {
        state.set(
          id,
          field(event.payload, "hold") === false ? "stopping" : "held",
        );
        recorded.set(id, true);
      } else if (event.type === "run_dispatched") {
        state.delete(id);
        recorded.set(id, false);
      } else if (
        event.type === ASSIGNMENT_STOP_RELEASED &&
        state.get(id) === "stopping"
      )
        state.set(id, "released");
    }
    index = { state, recorded };
    stoppedAssignments.set(events, index);
  }
  return index;
}

/**
 * C-211: a work-item Assignment the human paused stays stopped until the
 * human starts it again. The latest of its `assignment_stopped` and
 * `run_dispatched` events decides: the Dispatcher does not wake, replace or
 * start a session for it in between (new bells stay pending), and host_ops
 * cannot restart it either.
 *
 * C-620: a managed stop (`hold: false`) fences the same way only until its
 * terminal release is confirmed. After `assignment_stop_released` it is no
 * longer stopped: like a recycled session, new work starts a fresh one.
 */
export function stoppedByHuman(
  events: readonly Event[],
  assignment_id: AssignmentId,
): boolean {
  const state = stopIndex(events).state.get(assignment_id);
  return state === "held" || state === "stopping";
}

/** Any human stop (pause or managed) since the last dispatch, released or not. */
export function humanStopRecorded(
  events: readonly Event[],
  assignment_id: AssignmentId,
): boolean {
  return stopIndex(events).recorded.get(assignment_id) ?? false;
}

/** An explicit pause that only `cardigan assignment start` ends. */
export function pausedByHuman(
  events: readonly Event[],
  assignment_id: AssignmentId,
): boolean {
  return stopIndex(events).state.get(assignment_id) === "held";
}

const unfinished = (status: string) =>
  !["completed", "failed", "cancelled"].includes(status);
/** A never-started queued Run holds no terminal; a managed stop keeps it. */
const pendingWork = (r: Run) =>
  r.status === "queued" &&
  !r.started_at &&
  !r.dispatch_stop &&
  !r.inactivity_stop;

/**
 * `cardigan assignment stop` for a work-item Assignment, in two steps around
 * the terminal release.
 *
 * 1. Before the terminal is touched: record `assignment_stopped`, so the
 *    Dispatcher starts nothing for it from now on. A pause (`hold`, the
 *    default here) cancels its queued Runs (they hold no terminal and no run
 *    slot); a managed stop keeps never-started queued Runs as pending work.
 *    Refused while a host operation is pending, so the two never leave each
 *    other unfinishable.
 * 2. With `released_runtime_ref`, once the host has released that terminal:
 *    cancel the remaining unfinished Runs, settle the runtime state and clear
 *    the ref. Until then the running Run keeps its run slot, so a failed
 *    release neither under-counts capacity nor loses the ref to retry with.
 *    A no-op when the stop no longer holds or the session changed. After a
 *    managed stop's release the Assignment is no longer stopped (C-620).
 */
export function stopWorkItemAssignment(
  state: CommandState,
  actor: Actor,
  p: {
    assignment_id: AssignmentId;
    reason: string;
    released_runtime_ref?: RuntimeRef;
    /** C-620: false = managed stop, woken by new work after release. */
    hold?: boolean;
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
    // A managed stop never downgrades an existing pause.
    const hold = (p.hold ?? true) || pausedByHuman(state.events, a.id);
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
      const managed = !pausedByHuman(state.events, a.id);
      const runs = d
        .list("runs")
        .filter(
          (r) =>
            r.assignment_id === a.id &&
            unfinished(r.status) &&
            !(managed && pendingWork(r)),
        );
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
        ...retirementWaitReceipt(a),
        assignment_id: a.id,
        cancelled_run_ids: runs.map((r) => r.id),
      });
      return { assignment: next, cancelled: runs.length };
    }
    const queued = d
      .list("runs")
      .filter(
        (r) =>
          r.assignment_id === a.id &&
          r.status === "queued" &&
          !(!hold && pendingWork(r)),
      );
    cancel(queued);
    d.emit(
      ASSIGNMENT_STOPPED,
      card,
      {
        assignment_id: a.id,
        hold,
        cancelled_run_ids: queued.map((r) => r.id),
      },
      {
        type: "status_change",
        body: hold
          ? `Paused ${a.id}`
          : `Stopped ${a.id}; new work starts a new session`,
      },
    );
    return { assignment: a, cancelled: queued.length };
  });
}
