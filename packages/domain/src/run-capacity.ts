import type { Assignment, Run } from "./entities.js";

export const DEFAULT_QUEUED_RECHECK_AFTER_MS = 5 * 60_000;
export const DEFAULT_RUN_LIMIT = 4;
export const DEFAULT_MAX_RUN_LIMIT = 16;

/** Cross-project machine totals only; no project, card or Run identities. */
export interface MachineRunCapacity {
  readonly machine_id: string;
  readonly label: string;
  /** Non-exempt Agent occupancy, including startup/stop reservations. */
  readonly running: number;
  /** Absolute Agent occupancy, including standing PMs and host_ops. */
  readonly total_running: number;
  readonly limit: number;
  readonly max_limit: number;
  /** Ordinary Runs waiting for capacity, excluding reserved startups. */
  readonly queued: number;
  readonly merge_check_slots: number;
}

/** Host-provided read port; absence must not be reported as zero capacity. */
export type ReadRunCapacity = () => readonly MachineRunCapacity[] | null;

export const runLimitMaximumMessage = (maximum: number): string =>
  `并发上限不能超过 ${maximum}。`;

/** C-296: trusted standing PM/host_ops assignments bypass only capacity. */
export function canDispatchRun(
  limit: number,
  occupied: number,
  capacityExempt: boolean,
): boolean {
  return (
    capacityExempt ||
    (Number.isSafeInteger(limit) &&
      limit > 0 &&
      Number.isSafeInteger(occupied) &&
      occupied >= 0 &&
      limit > occupied)
  );
}

export const isStandingPm = (assignment: Assignment): boolean =>
  assignment.scope === "standing" && assignment.role_id === "pm";

export const isRunCapacityExempt = (assignment: Assignment): boolean =>
  assignment.scope === "standing" &&
  (assignment.role_id === "pm" || assignment.role_id === "host_ops");

/** Publication is for a new start, never a continuation or a fenced stop. */
export const awaitsStartPublication = (run: Run): boolean =>
  (run.status === "queued" || run.status === "dispatched") &&
  !run.started_at &&
  !run.inactivity_stop &&
  !run.dispatch_stop;

/** Physical occupancy, including stop reservations until exit is confirmed. */
export const runOccupiesSlot = (run: Run): boolean =>
  Boolean(
    run.inactivity_stop ||
      run.dispatch_stop ||
      (run.launch_publication &&
        !["started", "exited"].includes(run.launch_publication.phase)) ||
      ["dispatched", "acked", "running"].includes(run.status),
  );

/** Absolute Run occupancy; capacity callers must also classify the owner. */
export function occupiedRunSlots(
  assignments: readonly Assignment[],
  runs: readonly Run[],
  machine: string,
): number {
  const owners = new Set(
    assignments.filter((a) => a.machine_id === machine).map((a) => a.id),
  );
  return runs.filter((r) => owners.has(r.assignment_id) && runOccupiesSlot(r))
    .length;
}

export interface DispatchOrder {
  readonly dispatch_tier?: 1 | 2 | 3 | 4;
  readonly dispatch_reason?: string;
  readonly priority?: number;
  readonly critical_path_length?: number;
  readonly project_id: string;
  readonly assignment_id: string;
  readonly created_at: string;
  readonly trigger_event_id: string;
}

/** Finish existing work first; live card rank, original FIFO and stable ties within a tier. */
export function compareDispatchOrder(
  a: DispatchOrder,
  b: DispatchOrder,
): number {
  return (
    (a.dispatch_tier ?? 4) - (b.dispatch_tier ?? 4) ||
    (b.priority ?? 0) - (a.priority ?? 0) ||
    (b.critical_path_length ?? 0) - (a.critical_path_length ?? 0) ||
    a.created_at.localeCompare(b.created_at) ||
    a.trigger_event_id.localeCompare(b.trigger_event_id) ||
    a.project_id.localeCompare(b.project_id) ||
    a.assignment_id.localeCompare(b.assignment_id, "en", { numeric: true })
  );
}

export interface QueuedRun extends DispatchOrder {
  readonly machine_id: string;
  readonly run_id: string;
  readonly card_id?: string;
}
export interface RunQueuePosition extends QueuedRun {
  readonly ahead: number;
}

/** Positions count waiting Runs on the same machine, excluding exempt owners. */
export function runQueuePositions(
  queue: readonly QueuedRun[],
): RunQueuePosition[] {
  const counts = new Map<string, number>();
  return [...queue].sort(compareDispatchOrder).map((run) => {
    const ahead = counts.get(run.machine_id) ?? 0;
    counts.set(run.machine_id, ahead + 1);
    return { ...run, ahead };
  });
}
