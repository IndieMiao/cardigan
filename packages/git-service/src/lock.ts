/** Thrown when the shared base clone stays locked past the wait limit; retryable. */
export class RepositoryLockTimeoutError extends Error {
  readonly code = "repository_lock_timeout";
  constructor(readonly waitMs: number) {
    super(`Repository lock not acquired within ${waitMs}ms`);
    this.name = "RepositoryLockTimeoutError";
  }
}

export interface RepositoryLockKey {
  readonly machine_id?: string;
  readonly project_id: string;
  /** The project's shared base clone; also the in-process queue key. */
  readonly repository: string;
  /**
   * C-638: what the holder does (e.g. `candidate_push`), for lock timing
   * only; never part of the queue key.
   */
  readonly operation?: string;
}

/** C-638: one lock use, reported after release (or after giving up). */
export interface RepositoryLockSample {
  readonly project_id: string;
  readonly operation: string;
  /** Queue plus cross-process wait until the lock was held or given up. */
  readonly wait_ms: number;
  /** From acquisition to release; absent when the lock was never held. */
  readonly hold_ms?: number;
  readonly outcome: "held" | "timeout" | "failed";
}
/** Run `work` while holding the project's base-clone lock. */
export type RepositoryLock = <T>(
  key: RepositoryLockKey,
  work: () => Promise<T>,
) => Promise<T>;

export interface RepositoryLockOptions {
  /** Total wait for both layers; default 30 seconds. */
  readonly waitMs?: number;
  /**
   * Optional cross-process layer, taken after the in-process slot with the
   * remaining wait budget. It resolves with a release function or rejects
   * (a `RepositoryLockTimeoutError` when its own wait ran out).
   */
  readonly acquire?: (
    key: RepositoryLockKey,
    remainingMs: number,
  ) => Promise<() => Promise<void>>;
  readonly now?: () => number;
  /** C-638: timing of every use; a throwing observer is ignored. */
  readonly observe?: (sample: RepositoryLockSample) => void;
}

// Shared by every lock in this process: services are created per request, so
// the queue must not live on an instance.
const tails = new Map<string, Promise<void>>();

function inProcessSlot(key: string, waitMs: number) {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  // Drop the map entry once the queue drains, so keys do not accumulate.
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RepositoryLockTimeoutError(waitMs)),
      waitMs,
    );
  });
  return Promise.race([previous, timeout]).then(
    () => {
      clearTimeout(timer);
      return release;
    },
    (error: unknown) => {
      clearTimeout(timer);
      // A waiter that gave up keeps its place as a pass-through, so the
      // queue stays ordered behind whoever still holds the lock.
      void previous.then(release);
      throw error;
    },
  );
}

/** §12: serialize fetch and worktree changes on one project's base clone. */
export function repositoryLock(
  options: RepositoryLockOptions = {},
): RepositoryLock {
  const waitMs = options.waitMs ?? 30_000,
    now = options.now ?? Date.now;
  if (!Number.isSafeInteger(waitMs) || waitMs <= 0)
    throw new Error("Repository lock wait must be a positive integer");
  return async (key, work) => {
    const started = now();
    let acquired: number | undefined;
    let timedOut = false;
    try {
      const release = await inProcessSlot(
        JSON.stringify([
          key.machine_id ?? "local",
          key.project_id,
          key.repository,
        ]),
        waitMs,
      );
      try {
        const remaining = waitMs - (now() - started);
        if (remaining <= 0) throw new RepositoryLockTimeoutError(waitMs);
        const unlock = options.acquire
          ? await options.acquire(key, remaining)
          : undefined;
        acquired = now();
        try {
          return await work();
        } finally {
          await unlock?.();
        }
      } finally {
        release();
      }
    } catch (error) {
      timedOut =
        acquired === undefined && error instanceof RepositoryLockTimeoutError;
      throw error;
    } finally {
      if (options.observe) {
        const ended = now();
        try {
          options.observe({
            project_id: key.project_id,
            operation: key.operation ?? "unspecified",
            wait_ms: (acquired ?? ended) - started,
            ...(acquired === undefined ? {} : { hold_ms: ended - acquired }),
            outcome:
              acquired !== undefined ? "held" : timedOut ? "timeout" : "failed",
          });
        } catch {
          // Timing must never change the result of the locked work.
        }
      }
    }
  };
}

/** In-process only; the default when the host passes no lock. */
export const defaultRepositoryLock: RepositoryLock = repositoryLock();
