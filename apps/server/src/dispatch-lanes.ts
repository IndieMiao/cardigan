import type { AssignmentId } from "@cardigan/domain";

/**
 * C-788: wakes and session starts after a claim, one lane per machine.
 *
 * The dispatcher still claims (the capacity arbitration, inside one SQLite
 * transaction) in its FIFO order; only the post-claim delivery may overlap
 * with later candidates. A machine runs one delivery at a time, at most
 * `limit` run at once overall, and an Assignment's next candidate waits for
 * its previous delivery, so per-Assignment and per-machine order are
 * unchanged. A claim is taken only once its lane slot is free, so its bell
 * attempt does not wait behind other launches.
 */
export class LaunchLanes {
  private readonly machines = new Map<string, Promise<void>>();
  private readonly assignments = new Map<AssignmentId, Promise<void>>();
  private readonly running = new Set<Promise<void>>();
  private readonly errors: unknown[] = [];
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error("Invalid launch concurrency");
  }

  /** Resolves once the Assignment has no delivery in flight. */
  async idle(assignment: AssignmentId): Promise<void> {
    for (;;) {
      const current = this.assignments.get(assignment);
      if (!current) return;
      await current;
    }
  }

  /**
   * Wait for the machine's lane and an overall slot, then hold both until the
   * returned slot runs a delivery or is released unused.
   */
  async acquire(assignment: AssignmentId, machine: string): Promise<LaneSlot> {
    for (;;) {
      const busy =
        this.machines.get(machine) ?? this.assignments.get(assignment);
      if (busy) {
        await busy;
        continue;
      }
      if (this.active >= this.limit) {
        await new Promise<void>((resolve) => this.waiters.push(resolve));
        continue;
      }
      break;
    }
    this.active++;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.machines.set(machine, held);
    this.assignments.set(assignment, held);
    let done = false;
    const free = () => {
      if (done) return;
      done = true;
      if (this.machines.get(machine) === held) this.machines.delete(machine);
      if (this.assignments.get(assignment) === held)
        this.assignments.delete(assignment);
      this.active--;
      for (const wake of this.waiters.splice(0)) wake();
      release();
    };
    return {
      release: free,
      run: (work, after) => {
        const task = (async () => {
          try {
            await work();
          } finally {
            free();
          }
          after?.();
        })().catch((error: unknown) => {
          this.errors.push(error);
        });
        this.running.add(task);
        void task.finally(() => this.running.delete(task));
      },
    };
  }

  /** Wait for every delivery; rethrow the first failure, if any. */
  async drain(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
    if (this.errors.length) throw this.errors[0];
  }
}

export interface LaneSlot {
  /** Give the slot back without delivering (the claim was skipped). */
  release(): void;
  /** Deliver in the background; the slot is freed when `work` settles, then `after` runs. */
  run(work: () => Promise<void>, after?: () => void): void;
}
