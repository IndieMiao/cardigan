import { readFileSync } from "node:fs";
import type { ProjectId } from "@cardigan/domain";
import type { Store } from "@cardigan/store";

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

/** Called after authenticated readiness, released after the executor settles (even on errors). */
export function acquireMergeCheckCapacity(
  store: Store,
  project: ProjectId,
  attempt: string,
  owner: ExecutionOwner | undefined = executionOwner(process.pid),
): () => void {
  if (!owner) return () => {};
  store.uow.run(() =>
    store.database
      .prepare(`INSERT INTO merge_check_capacity
    (project_id, attempt_id, machine_id, owner_pid, owner_start) VALUES (?, ?, 'local', ?, ?)`)
      .run(project, attempt, owner.pid, owner.start),
  );
  return () =>
    store.uow.run(() => {
      store.database
        .prepare(`DELETE FROM merge_check_capacity
      WHERE project_id = ? AND attempt_id = ? AND owner_pid = ? AND owner_start = ?`)
        .run(project, attempt, owner.pid, owner.start);
    });
}

/** Caller holds a read or write transaction. Stale rows never reserve slots after restart. */
export function runningMergeChecks(store: Store): number {
  const rows = store.database
    .prepare(
      "SELECT owner_pid, owner_start FROM merge_check_capacity WHERE machine_id = 'local'",
    )
    .all();
  return rows.filter(
    (row) => executionOwner(Number(row.owner_pid))?.start === row.owner_start,
  ).length;
}
