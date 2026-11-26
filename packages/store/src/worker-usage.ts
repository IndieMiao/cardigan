import type { Store } from "./store.js";

/** C-666: one kind of the project's directories on a worker. */
export interface WorkerUsageKindRecord {
  readonly bytes: number;
  readonly directories: number;
}
/**
 * C-666: the latest usage observation of one project binding on a worker.
 * `measured` carries the helper's report; `skipped` says why there is none
 * this time (an older helper release, or a failed read). A skipped
 * observation keeps the last measurement for display, with its own time.
 */
export interface WorkerUsageRecord {
  readonly observed_at: string;
  readonly status: "measured" | "skipped";
  readonly skipped_reason?: "helper_outdated" | "failed";
  readonly measured?: {
    readonly measured_at: string;
    readonly free_bytes: number;
    readonly total_bytes: number;
    readonly worktrees: WorkerUsageKindRecord;
    readonly builds: WorkerUsageKindRecord;
    readonly runs: WorkerUsageKindRecord;
    readonly complete: boolean;
  };
}

export function readWorkerUsage(
  store: Store,
  project: string,
  machine: string,
): WorkerUsageRecord | null {
  const row = store.database
    .prepare(
      "SELECT doc FROM worker_usage WHERE project_id = ? AND machine_id = ?",
    )
    .get(project, machine);
  return row ? (JSON.parse(String(row.doc)) as WorkerUsageRecord) : null;
}

export function listWorkerUsage(
  store: Store,
  project: string,
): readonly ({ readonly machine_id: string } & WorkerUsageRecord)[] {
  return store.database
    .prepare(
      "SELECT machine_id, doc FROM worker_usage WHERE project_id = ? ORDER BY machine_id",
    )
    .all(project)
    .map((row) => ({
      machine_id: String(row.machine_id),
      ...(JSON.parse(String(row.doc)) as WorkerUsageRecord),
    }));
}

/** Only the host's usage observation writes this table; no Agent command does. */
export function recordWorkerUsage(
  store: Store,
  project: string,
  machine: string,
  record: WorkerUsageRecord,
): void {
  store.database
    .prepare(
      "INSERT INTO worker_usage VALUES (?, ?, ?, ?) ON CONFLICT(project_id, machine_id) DO UPDATE SET observed_at = excluded.observed_at, doc = excluded.doc",
    )
    .run(project, machine, record.observed_at, JSON.stringify(record));
}
