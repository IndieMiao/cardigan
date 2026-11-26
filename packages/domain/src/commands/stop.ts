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
import { dropReleasedRetirement } from "./idle-session-retirement.js";
import { replayStopDeferredResume } from "./resumption.js";

import {
  ASSIGNMENT_STOP_EXIT_CONFIRMED,
  ASSIGNMENT_STOP_RELEASED,
  ASSIGNMENT_STOPPED,
  pausedByHuman,
  stopExitConfirmed,
  stoppedByHuman,
  stopReleasePending,
} from "./stop-state.js";

export {
  humanStopRecorded,
  openStopEpisodeStart,
  pausedByHuman,
  recordHumanStart,
  stopExitConfirmed,
  stoppedByHuman,
} from "./stop-state.js";

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
 *    A no-op when the session changed. After a managed stop's release the
 *    Assignment is no longer stopped (C-620).
 *
 * C-645: step 2 does not depend on the stop still holding. A human start (or a
 * dispatch onto the same terminal) between the two steps ends the stop, but
 * the host has already released the terminal step 1 was recorded for. The
 * settlement then still cancels that session's Runs and clears the ref, and
 * keeps never-started queued work such as the human start's Run.
 */
export function stopWorkItemAssignment(
  state: CommandState,
  actor: Actor,
  p: {
    assignment_id: AssignmentId;
    reason: string;
    released_runtime_ref?: RuntimeRef;
    /**
     * C-620: host-proven exit of this exact session, recorded before cleanup
     * so a retried stop reuses it instead of looking for a removed terminal.
     */
    exit_confirmed_ref?: RuntimeRef;
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
    if (p.exit_confirmed_ref !== undefined) {
      if (
        !stoppedByHuman(state.events, a.id) ||
        JSON.stringify(a.runtime_ref) !==
          JSON.stringify(p.exit_confirmed_ref) ||
        stopExitConfirmed(state.events, a.id, p.exit_confirmed_ref)
      )
        return { assignment: a, cancelled: 0 };
      d.emit(ASSIGNMENT_STOP_EXIT_CONFIRMED, card, {
        assignment_id: a.id,
        runtime_ref: { ...p.exit_confirmed_ref },
      });
      return { assignment: a, cancelled: 0 };
    }
    if (p.released_runtime_ref !== undefined) {
      const holds = stoppedByHuman(state.events, a.id);
      if (
        !(
          holds ||
          stopReleasePending(state.events, a.id, p.released_runtime_ref)
        ) ||
        JSON.stringify(a.runtime_ref) !== JSON.stringify(p.released_runtime_ref)
      )
        return { assignment: a, cancelled: 0 };
      // A start that ended the stop is no pause: its queued Run is kept.
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
      // C-752 (sensen A-388): an idle retirement (often handed off on a
      // macOS worker) of the session just released has nothing left to
      // retire. Left behind without a binding, C-690 never supersedes it and
      // the dispatcher keeps every later bell fenced as idle_retirement until
      // a human start, despite "new work starts a new session".
      const owner = dropReleasedRetirement(d, a, card);
      // A later start launches from a clean runtime state, as after a restart.
      const runtime_state = ["unknown", "lost"].includes(a.runtime_state)
        ? unwrap(transition("runtime", a.runtime_state, "session_replaced"))
        : a.runtime_state === "running"
          ? unwrap(transition("runtime", a.runtime_state, "run_finished"))
          : a.runtime_state;
      const next = { ...owner, runtime_state, runtime_ref: null };
      d.put("assignments", next);
      d.emit(ASSIGNMENT_STOP_RELEASED, card, {
        ...retirementWaitReceipt(a),
        assignment_id: a.id,
        cancelled_run_ids: runs.map((r) => r.id),
        ...(holds ? {} : { superseded: true }),
      });
      // C-620: work that became ready during the stop window starts now.
      if (managed) replayStopDeferredResume(d, next);
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
        // C-645: the session this stop releases; its settlement depends on it.
        ...(a.runtime_ref ? { runtime_ref: { ...a.runtime_ref } } : {}),
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
