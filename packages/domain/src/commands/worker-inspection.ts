import { assignmentCardId } from "../card-hold.js";
import type { Actor } from "../entities.js";
import { eventsOfType } from "../event-index.js";
import type { AssignmentId, RunId } from "../ids.js";
import { runOccupiesSlot } from "../run-capacity.js";
import { type CommandPorts, type CommandState, command } from "./core.js";

export interface WorkerInspectionRequest {
  machine_id: string;
  assignment_id: AssignmentId;
  run_id?: RunId | undefined;
}

export const DEFAULT_WORKER_INSPECTION_INTERVAL_MS = 10_000;

/** Reservations may own a slot before a session exists. They do not prove reuse. */
export function workerInspectionTarget(
  state: CommandState,
  p: WorkerInspectionRequest,
) {
  const assignment = state.assignments.find((a) => a.id === p.assignment_id);
  const runs = state.runs.filter((r) => r.assignment_id === p.assignment_id);
  const occupants = runs.filter(runOccupiesSlot);
  const occupant = occupants.length === 1 ? occupants[0] : undefined;
  const run = p.run_id ? runs.find((r) => r.id === p.run_id) : occupant;
  // An unqualified query of an idle Assignment observes the Assignment, not
  // a particular completed or queued Run. Ambiguous occupancy fails closed.
  const current = run ? run === occupant : !p.run_id && occupants.length === 0;
  const launchId = assignment?.runtime_ref?.launch_generation?.run_id;
  const harness =
    run?.harness ??
    (current && !run && launchId
      ? runs.find((r) => r.id === launchId)?.harness
      : undefined);
  const platform = state.machines?.find((m) => m.id === p.machine_id)?.os;
  return { assignment, run, current, harness, platform };
}

/** Only an authenticated, numbered request reaches this journal. Never store evidence here. */
export function admitWorkerInspection(
  state: CommandState,
  actor: Actor,
  p: WorkerInspectionRequest,
  ports: CommandPorts,
  intervalMs = DEFAULT_WORKER_INSPECTION_INTERVAL_MS,
) {
  return command(state, actor, "host_ops_inspect_worker", ports, (d) => {
    const target = workerInspectionTarget(state, p);
    const { assignment, run } = target;
    const card =
      assignment && assignmentCardId(assignment, state, run?.trigger_event_id);
    const since = Date.parse(d.now) - intervalMs;
    const limited = eventsOfType(
      state.events,
      "worker_inspection_requested",
    ).some(
      (e) =>
        (e.payload as { status?: string }).status === "admitted" &&
        Date.parse(e.created_at) > since,
    );
    const status =
      !target.platform ||
      !assignment ||
      assignment.external ||
      assignment.machine_id !== p.machine_id ||
      (p.run_id && !run)
        ? "target_mismatch"
        : limited
          ? "rate_limited"
          : "admitted";
    d.emit("worker_inspection_requested", card, {
      machine_id: target.platform ? p.machine_id : null,
      assignment_id: p.assignment_id,
      run_id: p.run_id ?? run?.id ?? null,
      status,
    });
    return { status, ...target };
  });
}
