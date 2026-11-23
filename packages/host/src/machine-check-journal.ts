import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Clock } from "@cardigan/domain";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import type {
  CheckKind,
  CheckResult,
  MachineCheckJob,
} from "./machine-check-types.js";
import { executionOwner } from "./process-identity.js";
import { settleUpgradeCheck } from "./worker-upgrade-gate.js";

export type {
  CheckKind,
  CheckResult,
  MachineCheckJob,
} from "./machine-check-types.js";

type Source = "cli" | "web" | "patrol";
type Audit = (
  tx: StoreTransactionContext,
  job: MachineCheckJob,
  joined: boolean,
) => void;
const defaultClock: Clock = { now: () => new Date().toISOString() };
// The store belongs to one controller. Reclaim only a provably dead incarnation,
// never because a check took too long. No process identity leaves the host.
function incarnation(pid: number): string | undefined {
  if (process.platform === "linux") return executionOwner(pid)?.start;
  // POSIX fallback for local checks on macOS, which has no procfs.
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return undefined;
    throw e;
  }
  const ps = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    env: { LC_ALL: "C", TZ: "UTC" },
    timeout: 1000,
  });
  const start = ps.stdout?.trim();
  if (ps.status !== 0 || !start) throw new Error("Cannot identify check owner");
  return start;
}
function projected(row: Record<string, unknown>) {
  const job = JSON.parse(String(row.doc)) as MachineCheckJob;
  if (job.status === "running") {
    try {
      if (incarnation(Number(row.owner_pid)) !== row.owner_start)
        return {
          ...job,
          status: "failed" as const,
          step: "interrupted",
          failed_steps: ["interrupted"],
        };
    } catch {
      /* Unknown is still occupied. */
    }
  }
  return job;
}
export class MachineCheckJournal {
  constructor(
    readonly store: Store,
    readonly clock: Clock = defaultClock,
  ) {}
  read(machine: string, id: string) {
    const row = this.store.database
      .prepare("SELECT * FROM machine_check_jobs WHERE machine_id=? AND id=?")
      .get(machine, id);
    return row && projected(row);
  }
  latest(machine: string, project: string, kind?: CheckKind) {
    const filter = kind ? "kind=?" : "explicitly_requested=1";
    const row = this.store.database
      .prepare(
        `SELECT * FROM machine_check_jobs WHERE machine_id=? AND project_id=? AND ${filter} ORDER BY rowid DESC LIMIT 1`,
      )
      .get(machine, project, ...(kind ? [kind] : []));
    return row ? projected(row) : null;
  }
  /** C-599: any check of this machine (any project or source) still owned by a live process. */
  running(machine: string) {
    return this.store.database
      .prepare(
        "SELECT * FROM machine_check_jobs WHERE machine_id=? AND status='running'",
      )
      .all(machine)
      .some((row) => projected(row).status === "running");
  }
  claim(
    project: string,
    machine: string,
    kind: CheckKind,
    source: Source,
    audit?: Audit,
  ) {
    return this.store.uow.run((tx) => {
      const db = this.store.database;
      const row = db
        .prepare(
          "SELECT * FROM machine_check_jobs WHERE machine_id=? AND status='running'",
        )
        .get(machine);
      if (row) {
        const job = projected(row);
        if (job.status === "running") {
          audit?.(tx, job, true);
          // An explicit request that joins a patrol must still be discoverable
          // after a reload. A busy CLI worker did not request another check.
          if (
            !row.explicitly_requested &&
            (source === "web" ||
              (source === "cli" &&
                kind === "machine" &&
                job.kind === kind &&
                job.project_id === project))
          )
            db.prepare(
              "UPDATE machine_check_jobs SET explicitly_requested=1 WHERE id=?",
            ).run(job.id);

          return { job, joined: true };
        }
        this.save(job);
      }
      const now = this.clock.now();
      const job: MachineCheckJob = {
        id: randomUUID(),
        project_id: project,
        machine_id: machine,
        kind,
        status: "running",
        step: "queued",
        started_at: now,
        checked_at: now,
        failed_steps: [],
      };
      const owner = incarnation(process.pid);
      if (!owner) throw new Error("Cannot identify check owner");
      db.prepare(
        "INSERT INTO machine_check_jobs VALUES (?,?,?,?,?,'running',?,?,?)",
      ).run(
        job.id,
        machine,
        project,
        kind,
        Number(source !== "patrol"),
        process.pid,
        owner,
        JSON.stringify(job),
      );
      // A newly claimed worker check supersedes the previous worker proof even if this process dies.
      if (kind === "worker")
        db.prepare(
          "UPDATE worker_helper_upgrades SET state='failed' WHERE project_id=? AND machine_id=? AND state='worker_checked'",
        ).run(project, machine);
      audit?.(tx, job, false);
      return { job, joined: false };
    });
  }
  private save(job: MachineCheckJob) {
    const changed = this.store.database
      .prepare(
        "UPDATE machine_check_jobs SET status=?,doc=? WHERE id=? AND status='running'",
      )
      .run(job.status, JSON.stringify(job), job.id);
    if (changed.changes !== 1)
      throw new Error("Machine check no longer current");
  }
  async execute<T>(
    job: MachineCheckJob,
    work: (progress: (step: string) => void) => Promise<T>,
    result: (value: T) => CheckResult,
    finished?: (tx: StoreTransactionContext, job: MachineCheckJob) => void,
  ) {
    let step = job.step;
    const complete = (outcome: CheckResult) => {
      const final = {
        ...job,
        ...outcome,
        step: "finished",
        checked_at: this.clock.now(),
      };
      try {
        this.store.uow.run((tx) => {
          this.save(final);
          settleUpgradeCheck(this.store, tx, final);
          finished?.(tx, final);
        });
      } catch (error) {
        // If the completion/audit transaction rolled back, don't leave a live
        // listener permanently occupying the slot or advertise success.
        this.store.uow.run(() =>
          this.save({
            ...final,
            status: "failed",
            failed_steps: ["record_result"],
          }),
        );
        throw error;
      }
    };
    let value: T;
    try {
      value = await work((next) => {
        step = next;
        this.store.uow.run(() =>
          this.save({ ...job, step, checked_at: this.clock.now() }),
        );
      });
    } catch (e) {
      complete({ status: "failed", failed_steps: [step] });
      throw e;
    }
    complete(result(value));
    return value;
  }
}
