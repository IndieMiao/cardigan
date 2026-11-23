import type { Assignment, Event, Run, RuntimeRef } from "../entities.js";
import { fullEventHistory } from "../event-index.js";
import type { AssignmentId, CardId } from "../ids.js";
import type { CommandDraft } from "./core.js";

export const ASSIGNMENT_STOPPED = "assignment_stopped";
export const ASSIGNMENT_STOP_RELEASED = "assignment_stop_released";
/** C-624: a human start queued for capacity; ends the stop like a dispatch. */
export const ASSIGNMENT_START_REQUESTED = "assignment_start_requested";
/** C-620: exit of the stopped session proven once, reused by a retry. */
export const ASSIGNMENT_STOP_EXIT_CONFIRMED = "assignment_stop_exit_confirmed";

/**
 * C-620: `held` is an explicit human pause (and every legacy stop without a
 * `hold` field). `stopping` is a managed stop whose terminal release is not
 * confirmed yet; once released it no longer fences dispatch, so new work
 * starts a fresh session automatically.
 */
type StopState = "held" | "stopping" | "released";
interface StopIndex {
  readonly state: ReadonlyMap<unknown, StopState>;
  /** Latest of a stop (any kind) and a start (dispatch or human start) is the stop. */
  readonly recorded: ReadonlyMap<unknown, boolean>;
  /** Index of the first stop of the episode that is still unreleased. */
  readonly episode: ReadonlyMap<unknown, number>;
  /** Session whose exit this unreleased episode has already proven. */
  readonly exited: ReadonlyMap<unknown, unknown>;
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
    const episode = new Map<unknown, number>();
    const exited = new Map<unknown, unknown>();
    const close = (id: unknown) => {
      episode.delete(id);
      exited.delete(id);
    };
    // C-643: `run_dispatched` is telemetry; array order covers the full history.
    for (const [at, event] of fullEventHistory(events).entries()) {
      const id = field(event.payload, "assignment_id");
      if (event.type === ASSIGNMENT_STOPPED) {
        state.set(
          id,
          field(event.payload, "hold") === false ? "stopping" : "held",
        );
        recorded.set(id, true);
        // A retried stop continues the same episode.
        if (!episode.has(id)) episode.set(id, at);
      } else if (
        event.type === "run_dispatched" ||
        (event.type === ASSIGNMENT_START_REQUESTED &&
          event.actor.kind === "human")
      ) {
        state.delete(id);
        recorded.set(id, false);
        close(id);
      } else if (event.type === ASSIGNMENT_STOP_RELEASED) {
        if (state.get(id) === "stopping") state.set(id, "released");
        close(id);
      } else if (
        event.type === ASSIGNMENT_STOP_EXIT_CONFIRMED &&
        episode.has(id)
      )
        exited.set(id, JSON.stringify(field(event.payload, "runtime_ref")));
    }
    index = { state, recorded, episode, exited };
    stoppedAssignments.set(events, index);
  }
  return index;
}

/**
 * C-211: a work-item Assignment the human paused stays stopped until the
 * human starts it again. The latest of its `assignment_stopped`,
 * `assignment_start_requested` (human only) and `run_dispatched` events
 * decides: the Dispatcher does not wake, replace or start a session for it in
 * between (new bells stay pending), and host_ops cannot restart it either.
 *
 * C-624: a human start that has to queue for capacity is still the human's
 * start. Before, only the eventual dispatch lifted the stop, so the queued Run
 * was never dispatched by anyone and held the head of the machine queue.
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

/**
 * C-620: index (in `events`) of the first `assignment_stopped` of the stop
 * episode that has not been released or ended by a new dispatch yet. A
 * retried stop belongs to the same episode.
 */
/** Position in `fullEventHistory(events)`, not in a telemetry-free array. */
export function openStopEpisodeStart(
  events: readonly Event[],
  assignment_id: AssignmentId,
): number | undefined {
  return stopIndex(events).episode.get(assignment_id);
}

/** C-620: this unreleased stop has already proven `ref`'s exit. */
export function stopExitConfirmed(
  events: readonly Event[],
  assignment_id: AssignmentId,
  ref: RuntimeRef,
): boolean {
  return stopIndex(events).exited.get(assignment_id) === JSON.stringify(ref);
}

/**
 * C-624: record a human start of a stopped work-item Assignment when its Run is
 * queued, not only once it is dispatched. Only the human ends a human stop.
 */
export function recordHumanStart(
  d: CommandDraft,
  assignment: Assignment,
  run: Run,
  card: CardId | undefined,
) {
  if (
    d.actor.kind !== "human" ||
    assignment.scope !== "work_item" ||
    !stoppedByHuman(d.state.events, assignment.id)
  )
    return;
  d.emit(ASSIGNMENT_START_REQUESTED, card, {
    assignment_id: assignment.id,
    run_id: run.id,
  });
}
