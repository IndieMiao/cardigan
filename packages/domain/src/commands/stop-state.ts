import type { Event } from "../entities.js";
import type { AssignmentId } from "../ids.js";

export const ASSIGNMENT_STOPPED = "assignment_stopped";
export const ASSIGNMENT_STOP_RELEASED = "assignment_stop_released";

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
