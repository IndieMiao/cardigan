import type { Clock, ProjectId } from "@cardigan/domain";
import {
  readWorkerUsage,
  recordWorkerUsage,
  type Store,
  type WorkerUsageRecord,
} from "@cardigan/store";
import type { ReconcileGit } from "./git.js";
import { systemClock } from "./merge-loop.js";

/**
 * C-666: below this much free space on a worker's volume, one reclaim of
 * released Assignments' directories starts. Earlier incidents hurt packaging
 * at 16 GB and left 8–9 GB; a Godot verifier build is about 1–1.5 GB.
 */
export const DEFAULT_WORKER_LOW_FREE_GIB = 20;
const GIB = 1024 ** 3;
export const WORKER_DISK_LOW = "worker_disk_space_low";
export const WORKER_DISK_RECOVERED = "worker_disk_space_recovered";

/** `CARDIGAN_WORKER_LOW_FREE_GIB`: a positive integer number of GiB. */
export function workerLowFreeBytes(
  value = process.env.CARDIGAN_WORKER_LOW_FREE_GIB,
): number {
  const gib = Number(value ?? DEFAULT_WORKER_LOW_FREE_GIB);
  if (!Number.isSafeInteger(gib) || gib < 1 || gib > 1024 * 1024)
    throw new Error(
      "CARDIGAN_WORKER_LOW_FREE_GIB must be an integer between 1 and 1048576",
    );
  return gib * GIB;
}

const gib = (bytes: number) => (bytes / GIB).toFixed(1);

export interface WorkerUsageOptions {
  readonly store: Store;
  readonly git: Pick<ReconcileGit, "machineUsage" | "projectOf">;
  /** One full reclaim pass of the project's released directories. */
  readonly reclaim?: ((project: ProjectId) => Promise<void> | void) | undefined;
  readonly lowFreeBytes?: number;
  readonly clock?: Clock;
  readonly report?: (message: string) => void;
}

/**
 * C-666: after each machine check, read each remote binding's directory
 * usage through its helper and keep the latest. Entering low free space
 * records one notice on the project's timeline and starts one reclaim; the
 * next one waits until space has recovered. An older helper is only skipped
 * and reported: nothing here affects dispatch.
 */
export class WorkerUsageMonitor {
  constructor(private readonly options: WorkerUsageOptions) {}

  private get clock(): Clock {
    return this.options.clock ?? systemClock;
  }
  private report(message: string) {
    this.options.report?.(message);
  }

  async observe(project_id: ProjectId, machine_id: string): Promise<void> {
    const { store, git } = this.options;
    if (machine_id === "local") return;
    const read = git.machineUsage?.bind(git);
    const project = git.projectOf(project_id);
    if (!read || project === undefined) return;
    const previous = readWorkerUsage(store, project_id, machine_id);
    const skipped = (
      reason: NonNullable<WorkerUsageRecord["skipped_reason"]>,
    ): WorkerUsageRecord => ({
      observed_at: this.clock.now(),
      status: "skipped",
      skipped_reason: reason,
      ...(previous?.measured ? { measured: previous.measured } : {}),
    });
    let usage: Awaited<ReturnType<NonNullable<ReconcileGit["machineUsage"]>>>;
    try {
      usage = await read(project, machine_id);
    } catch (error) {
      recordWorkerUsage(store, project_id, machine_id, skipped("failed"));
      this.report(
        `worker usage for ${project_id}/${machine_id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (usage === undefined) return;
    if (usage.helper === "outdated") {
      if (previous?.skipped_reason !== "helper_outdated")
        this.report(
          `worker usage for ${project_id}/${machine_id} skipped: the worker runs the previous helper release; install the current one`,
        );
      recordWorkerUsage(
        store,
        project_id,
        machine_id,
        skipped("helper_outdated"),
      );
      return;
    }
    const at = this.clock.now();
    const { report } = usage;
    const measured = {
      measured_at: at,
      free_bytes: report.free_bytes,
      total_bytes: report.total_bytes,
      worktrees: { ...report.worktrees },
      builds: { ...report.builds },
      runs: { ...report.runs },
      complete: report.complete,
    };
    recordWorkerUsage(store, project_id, machine_id, {
      observed_at: at,
      status: "measured",
      measured,
    });
    await this.threshold(project_id, machine_id, measured);
  }

  private async threshold(
    project_id: ProjectId,
    machine_id: string,
    measured: NonNullable<WorkerUsageRecord["measured"]>,
  ) {
    const { store } = this.options;
    const limit = this.options.lowFreeBytes ?? workerLowFreeBytes();
    const low = measured.free_bytes < limit;
    const reclaim = this.options.reclaim;
    const entered = store.uow.run((tx) => {
      // One episode per machine, also across restarts: only a change is recorded.
      const last = store.database
        .prepare(
          `SELECT type FROM events WHERE project_id = ? AND card_id IS NULL
          AND type IN (?, ?) AND json_extract(doc, '$.actor.kind') = 'system'
          AND json_extract(doc, '$.payload.machine_id') = ?
          ORDER BY seq DESC LIMIT 1`,
        )
        .get(project_id, WORKER_DISK_LOW, WORKER_DISK_RECOVERED, machine_id);
      if ((last?.type === WORKER_DISK_LOW) === low) return false;
      if (!low && last === undefined) return false;
      tx.events.append(project_id, {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(project_id),
        type: low ? WORKER_DISK_LOW : WORKER_DISK_RECOVERED,
        actor: { kind: "system", project_id },
        created_at: this.clock.now(),
        payload: {
          machine_id,
          free_bytes: measured.free_bytes,
          total_bytes: measured.total_bytes,
          threshold_bytes: limit,
          worktrees_bytes: measured.worktrees.bytes,
          builds_bytes: measured.builds.bytes,
          runs_bytes: measured.runs.bytes,
          measured_at: measured.measured_at,
          ...(low
            ? {
                reclaim: reclaim ? "started" : "unavailable",
                notice: `机器 ${machine_id} 可用空间 ${gib(measured.free_bytes)} GiB，低于 ${gib(limit)} GiB。本项目占用：worktrees ${gib(measured.worktrees.bytes)} GiB，builds ${gib(measured.builds.bytes)} GiB，runs ${gib(measured.runs.bytes)} GiB。${reclaim ? "已触发一次已释放指派目录的回收。" : ""}`,
              }
            : {}),
        },
      });
      return low;
    });
    if (!entered || !reclaim) return;
    try {
      await reclaim(project_id);
    } catch (error) {
      this.report(
        `low-space reclaim for ${project_id}/${machine_id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
