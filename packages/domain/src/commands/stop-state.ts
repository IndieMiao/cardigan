import type { Assignment, Event, Run, RuntimeRef } from "../entities.js";
import { eventsOfTypes, fullEventHistory } from "../event-index.js";
import type { AssignmentId, CardId } from "../ids.js";
import type { CommandDraft } from "./core.js";

export const ASSIGNMENT_STOPPED = "assignment_stopped";
export const ASSIGNMENT_STOP_RELEASED = "assignment_stop_released";
/** C-624: a human start queued for capacity; ends the stop like a dispatch. */
export const ASSIGNMENT_START_REQUESTED = "assignment_start_requested";
/** C-620: exit of the stopped session proven once, reused by a retry. */
export const ASSIGNMENT_STOP_EXIT_CONFIRMED = "assignment_stop_exit_confirmed";
/**
 * C-732: a pause ended on the human's behalf: PM Ops (under the project's
 * `permission` delegation) or the human answered the system's resume
 * question. Ends the pause like a human start; the Dispatcher then delivers
 * the waiting bells in a fresh session.
 */
export const ASSIGNMENT_HOLD_RESUMED = "assignment_hold_resumed";

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
  /** First stop event of the episode that is still unreleased. */
  readonly episode: ReadonlyMap<unknown, Event>;
  /** Session whose exit this unreleased episode has already proven. */
  readonly exited: ReadonlyMap<unknown, unknown>;
  /**
   * C-645: session the latest stop was recorded for, until its release
   * settles. Unlike the fence, a later start or dispatch does not clear it:
   * the host has already started releasing that terminal.
   */
  readonly releasing: ReadonlyMap<unknown, string>;
  /** C-732: who recorded the latest stop of a still-held pause, and when. */
  readonly paused: ReadonlyMap<unknown, HeldPause>;
}
/** C-732: the author and time of the stop that holds an Assignment. */
export interface HeldPause {
  readonly by: string;
  readonly at: string;
  /** Event id of that `assignment_stopped`. */
  readonly event_id: string;
}
const authorOf = (actor: Event["actor"]) =>
  actor.kind === "assignment"
    ? `assignment:${actor.assignment_id}`
    : actor.kind;
// One index per immutable event snapshot. Array order (not timestamps or
// per-card sequence numbers) remains the authority, exactly as in the scan.
// C-671: only these types change the index; the type index keeps their order
// and also answers for stops on closed cards in the `slim` command state.
const STOP_TYPES = [
  ASSIGNMENT_STOPPED,
  "run_dispatched",
  ASSIGNMENT_START_REQUESTED,
  ASSIGNMENT_STOP_RELEASED,
  ASSIGNMENT_STOP_EXIT_CONFIRMED,
  ASSIGNMENT_HOLD_RESUMED,
];
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
    const episode = new Map<unknown, Event>();
    const exited = new Map<unknown, unknown>();
    const releasing = new Map<unknown, string>();
    const paused = new Map<unknown, HeldPause>();
    const close = (id: unknown) => {
      episode.delete(id);
      exited.delete(id);
    };
    // C-643: `run_dispatched` is telemetry; the lookup covers the full history.
    for (const event of eventsOfTypes(events, STOP_TYPES)) {
      const id = field(event.payload, "assignment_id");
      if (event.type === ASSIGNMENT_STOPPED) {
        const next =
          field(event.payload, "hold") === false ? "stopping" : "held";
        state.set(id, next);
        if (next === "held")
          paused.set(id, {
            by: authorOf(event.actor),
            at: event.created_at,
            event_id: event.id,
          });
        else paused.delete(id);
        recorded.set(id, true);
        // A retried stop continues the same episode.
        if (!episode.has(id)) episode.set(id, event);
        const session = field(event.payload, "runtime_ref");
        if (session !== undefined && session !== null)
          releasing.set(id, JSON.stringify(session));
        else releasing.delete(id);
      } else if (
        event.type === "run_dispatched" ||
        (event.type === ASSIGNMENT_START_REQUESTED &&
          event.actor.kind === "human") ||
        event.type === ASSIGNMENT_HOLD_RESUMED
      ) {
        state.delete(id);
        paused.delete(id);
        recorded.set(id, false);
        close(id);
      } else if (event.type === ASSIGNMENT_STOP_RELEASED) {
        if (state.get(id) === "stopping") state.set(id, "released");
        releasing.delete(id);
        close(id);
      } else if (
        event.type === ASSIGNMENT_STOP_EXIT_CONFIRMED &&
        episode.has(id)
      )
        exited.set(id, JSON.stringify(field(event.payload, "runtime_ref")));
    }
    index = { state, recorded, episode, exited, releasing, paused };
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
 *
 * C-732: `assignment_hold_resumed` (the answered resume question) ends a
 * pause like a human start.
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

/** C-732: who paused this Assignment and when, while the pause holds. */
export function heldPause(
  events: readonly Event[],
  assignment_id: AssignmentId,
): HeldPause | undefined {
  const index = stopIndex(events);
  return index.state.get(assignment_id) === "held"
    ? index.paused.get(assignment_id)
    : undefined;
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
  const start = stopIndex(events).episode.get(assignment_id);
  const at = start ? fullEventHistory(events).indexOf(start) : -1;
  return at >= 0 ? at : undefined;
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
 * C-645: the latest human stop was recorded for session `ref` and has not
 * settled yet, even if a human start or a dispatch ended the stop since. Its
 * terminal release is under way, so the settlement still applies.
 */
export function stopReleasePending(
  events: readonly Event[],
  assignment_id: AssignmentId,
  ref: RuntimeRef,
): boolean {
  return stopIndex(events).releasing.get(assignment_id) === JSON.stringify(ref);
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
