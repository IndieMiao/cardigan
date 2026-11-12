import type { Assignment, Run } from "./entities.js";

export const DEFAULT_RUN_LIMIT = 4;
export const DEFAULT_MAX_RUN_LIMIT = 16;

export const runLimitMaximumMessage = (maximum: number): string =>
  `并发上限不能超过 ${maximum}。`;

/** P2a-9: standing PMs may dispatch even when they fill the last slot. */
export function canDispatchRun(
  limit: number,
  occupied: number,
  standingPm: boolean,
): boolean {
  return (
    standingPm ||
    (Number.isSafeInteger(limit) &&
      limit > 0 &&
      Number.isSafeInteger(occupied) &&
      occupied >= 0 &&
      limit > occupied)
  );
}

export const isStandingPm = (assignment: Assignment): boolean =>
  assignment.scope === "standing" && assignment.role_id === "pm";

export function occupiedRunSlots(
  assignments: readonly Assignment[],
  runs: readonly Run[],
  machine: string,
): number {
  const owners = new Set(
    assignments.filter((a) => a.machine_id === machine).map((a) => a.id),
  );
  return runs.filter(
    (r) =>
      owners.has(r.assignment_id) &&
      (r.inactivity_stop ||
        r.dispatch_stop ||
        ["dispatched", "acked", "running"].includes(r.status)),
  ).length;
}

export interface DispatchOrder {
  readonly priority?: number;
  readonly project_id: string;
  readonly assignment_id: string;
  readonly created_at: string;
  readonly trigger_event_id: string;
}

/** Live card rank first, then the original event FIFO and stable ties. */
export function compareDispatchOrder(
  a: DispatchOrder,
  b: DispatchOrder,
): number {
  return (
    (b.priority ?? 0) - (a.priority ?? 0) ||
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

/** Positions count waiting Runs on the same machine, excluding running work/PMs. */
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
