import { CHECKOUT_LIMITS } from "@cardigan/host";

export class MergeLockBusy extends Error {}

/** Only acquisition times out. Never unlock a running writer or run a stale waiter. */
export class MergeMutex {
  private held = false;
  private readonly waiting = new Set<() => void>();
  get busy() {
    return this.held;
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.held) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          this.waiting.delete(wake);
          reject(new MergeLockBusy("Merge lock wait timed out"));
        }, CHECKOUT_LIMITS.lockWaitMs);
        this.waiting.add(wake);
      });
    } else this.held = true;
    try {
      return await work();
    } finally {
      const next = this.waiting.values().next().value;
      if (next) {
        this.waiting.delete(next);
        next();
      } else this.held = false;
    }
  }
}

// C-94: a baseline move and its durable record are indivisible to the push loop.
const locks = new Map<string, MergeMutex>();
export async function withPublication<T>(
  project_id: string,
  work: () => Promise<T>,
): Promise<T> {
  const lock = locks.get(project_id) ?? new MergeMutex();
  locks.set(project_id, lock);
  try {
    return await lock.run(work);
  } finally {
    if (!lock.busy && locks.get(project_id) === lock) locks.delete(project_id);
  }
}
