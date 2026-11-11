import { readFileSync } from "node:fs";
import type { ProjectId } from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { LOCAL_EXECUTOR } from "./merge-gate-executors.js";

export interface ExecutionOwner {
  readonly pid: number;
  /** Boot ID and Linux start ticks identify an incarnation, not just a PID. */
  readonly start: string;
}

/** Linux host/SSH-client process. A closed pipe makes the check supervisor cancel. */
export function executionOwner(pid: number): ExecutionOwner | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1)
    throw new Error("Invalid execution PID");
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(") ") + 2)
      .trim()
      .split(/\s+/u);
    if (["Z", "X"].includes(fields[0] ?? "")) return undefined;
    const ticks = fields[19];
    if (!ticks || !/^\d+$/u.test(ticks))
      throw new Error("Invalid execution identity");
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return { pid, start: `${boot}:${ticks}` };
  } catch (error) {
    if (
      ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return undefined;
    throw error;
  }
}

/**
 * Called after authenticated readiness, released after the executor settles (even on errors).
 * `machine` is the execution target (P2a-12 D): `local` or a merge-gate executor name.
 */
export function acquireMergeCheckCapacity(
  store: Store,
  project: ProjectId,
  attempt: string,
  owner: ExecutionOwner | undefined = executionOwner(process.pid),
  machine: string = LOCAL_EXECUTOR,
): () => void {
  if (!owner) return () => {};
  store.uow.run(() =>
    store.database
      .prepare(`INSERT INTO merge_check_capacity
    (project_id, attempt_id, machine_id, owner_pid, owner_start) VALUES (?, ?, ?, ?, ?)`)
      .run(project, attempt, machine, owner.pid, owner.start),
  );
  return () =>
    store.uow.run(() => {
      store.database
        .prepare(`DELETE FROM merge_check_capacity
      WHERE project_id = ? AND attempt_id = ? AND owner_pid = ? AND owner_start = ?`)
        .run(project, attempt, owner.pid, owner.start);
    });
}

/**
 * Caller holds a read or write transaction. Live merge checks per execution
 * target, across all projects. Stale rows never reserve slots after restart.
 */
export function runningMergeChecks(store: Store): Map<string, number> {
  const rows = store.database
    .prepare(
      "SELECT machine_id, owner_pid, owner_start FROM merge_check_capacity",
    )
    .all();
  const running = new Map<string, number>();
  for (const row of rows) {
    if (executionOwner(Number(row.owner_pid))?.start !== row.owner_start)
      continue;
    const machine = String(row.machine_id);
    running.set(machine, (running.get(machine) ?? 0) + 1);
  }
  return running;
}

/** Whether a remote executor may start another check under its `max_concurrent`. */
export function mergeCheckCapacityAvailable(
  store: Store,
  machine: string,
  limit: number,
): boolean {
  const running = store.uow.read(
    () => runningMergeChecks(store).get(machine) ?? 0,
  );
  return running < limit;
}
