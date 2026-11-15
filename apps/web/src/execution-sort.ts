import { compareDispatchOrder } from "@cardigan/domain";
import type { ExecutionAssignment, RunView } from "./api.js";

/** C-73: the execution view's "最近活动" order; newest first by default. */
export type ExecutionSort = "desc" | "asc";
export const DEFAULT_EXECUTION_SORT: ExecutionSort = "desc";

export const executionSortKey = (projectId: string) =>
  `cardigan.execution.sort.${projectId}`;

/** localStorage is optional (private mode/SSR); bad data means the default. */
export function readExecutionSort(projectId: string): ExecutionSort {
  try {
    const raw = window.localStorage.getItem(executionSortKey(projectId));
    return raw === "asc" || raw === "desc" ? raw : DEFAULT_EXECUTION_SORT;
  } catch {
    return DEFAULT_EXECUTION_SORT;
  }
}

export function writeExecutionSort(
  projectId: string,
  sort: ExecutionSort,
): void {
  try {
    window.localStorage.setItem(executionSortKey(projectId), sort);
  } catch {
    // The preference is optional; losing it must not break the page.
  }
}

const parsed = (value: string | null | undefined) => {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : { value, ms };
};

/**
 * The latest of the Assignment's MCP activity and its newest Run's queue,
 * start and finish times. A queued Run counts from when it was queued, so
 * running and queued work is not pinned to the top; it sorts like the rest.
 */
export function assignmentActivity(
  a: ExecutionAssignment,
  run: RunView | undefined,
): string | undefined {
  let latest: { value: string; ms: number } | undefined;
  for (const candidate of [
    a.last_mcp_activity_at,
    run?.finished_at,
    run?.started_at,
    run?.queued_at,
  ]) {
    const time = parsed(candidate);
    if (time && (latest === undefined || time.ms > latest.ms)) latest = time;
  }
  return latest?.value;
}

/**
 * Sort by activity in the chosen direction. Assignments without any activity
 * stay at the end either way; ties fall back to the Assignment id so the
 * order is stable across refreshes.
 */
export function sortByActivity<T extends ExecutionAssignment>(
  assignments: readonly T[],
  activityOf: (a: T) => string | undefined,
  sort: ExecutionSort,
): T[] {
  const sign = sort === "desc" ? -1 : 1;
  return assignments
    .map((a) => ({ a, at: parsed(activityOf(a))?.ms }))
    .sort((left, right) => {
      if (left.at === undefined || right.at === undefined) {
        if (left.at === right.at) return compareIds(left.a.id, right.a.id);
        return left.at === undefined ? 1 : -1;
      }
      return (
        sign * (left.at - right.at) || sign * compareIds(left.a.id, right.a.id)
      );
    })
    .map((entry) => entry.a);
}

const compareIds = (left: string, right: string) =>
  left.localeCompare(right, "en", { numeric: true });

/** Keep activity slots for other rows; waiting rows follow the host queue. */
export function sortCapacityWaits<T extends ExecutionAssignment>(
  rows: readonly T[],
): T[] {
  const waiting = rows
    .flatMap((row) =>
      row.queue_order ? [{ row, order: row.queue_order }] : [],
    )
    .sort((a, b) => compareDispatchOrder(a.order, b.order));
  let index = 0;
  return rows.map((a) =>
    a.queue_order === undefined ? a : (waiting[index++]?.row ?? a),
  );
}
