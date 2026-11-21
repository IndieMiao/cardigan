import { assignmentCardId } from "../card-hold.js";
import type { Actor } from "../entities.js";
import type { AssignmentId, RunId } from "../ids.js";
import { type CommandPorts, type CommandState, command } from "./core.js";

export interface WorkerInspectionRequest {
  machine_id: string;
  assignment_id: AssignmentId;
  run_id?: RunId | undefined;
}

export const DEFAULT_WORKER_INSPECTION_INTERVAL_MS = 10_000;

/** Only an authenticated, numbered request reaches this journal. Never store evidence here. */
export function admitWorkerInspection(
  state: CommandState,
  actor: Actor,
  p: WorkerInspectionRequest,
  ports: CommandPorts,
  intervalMs = DEFAULT_WORKER_INSPECTION_INTERVAL_MS,
) {
  return command(state, actor, "host_ops_inspect_worker", ports, (d) => {
    const machine = state.machines?.find((m) => m.id === p.machine_id);
    const assignment = state.assignments.find((a) => a.id === p.assignment_id);
    // Repository enumeration has no chronological ordering guarantee.
    const latest = state.runs.reduce<(typeof state.runs)[number] | undefined>(
      (last, r) =>
        r.assignment_id === p.assignment_id &&
        (!last || Number(r.id.slice(2)) > Number(last.id.slice(2)))
          ? r
          : last,
      undefined,
    );
    const run = p.run_id
      ? state.runs.find(
          (r) => r.id === p.run_id && r.assignment_id === p.assignment_id,
        )
      : latest;
    const card =
      assignment && assignmentCardId(assignment, state, run?.trigger_event_id);
    const since = Date.parse(d.now) - intervalMs;
    const limited = state.events.some(
      (e) =>
        e.type === "worker_inspection_requested" &&
        (e.payload as { status?: string }).status === "admitted" &&
        Date.parse(e.created_at) > since,
    );
    const status =
      !machine ||
      !assignment ||
      assignment.external ||
      assignment.machine_id !== p.machine_id ||
      (p.run_id && !run)
        ? "target_mismatch"
        : limited
          ? "rate_limited"
          : "admitted";
    d.emit("worker_inspection_requested", card, {
      machine_id: machine?.id ?? null,
      assignment_id: p.assignment_id,
      run_id: p.run_id ?? run?.id ?? null,
      status,
    });
    return { status, assignment, run, current: run?.id === latest?.id };
  });
}
