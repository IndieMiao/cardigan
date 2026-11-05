/**
 * M4.4: a bounded background loop for the merge, cleanup, reconcile and backup
 * phases. It never installs signal handlers and never owns the store: the
 * caller stops it before closing host resources, and `stop()` waits for the
 * tick that is currently running — SIGTERM must not cut a merge in half.
 */
export interface TimerLoopOptions {
  readonly tick: () => Promise<void>;
  readonly intervalMs?: number;
  /** Tick failures are reported and retried on the next interval. */
  readonly onError: (error: unknown) => void;
  readonly signal?: AbortSignal;
}
export interface TimerLoop {
  readonly done: Promise<void>;
  /** Idempotent: stop scheduling, wait for the running tick, then resolve. */
  stop(): Promise<void>;
}
const MAX_INTERVAL = 2_147_483_647;

export function startTimerLoop(options: TimerLoopOptions): TimerLoop {
  const interval = options.intervalMs ?? 600_000;
  if (
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    interval > MAX_INTERVAL
  )
    throw new Error("Invalid loop interval");
  let stopping = options.signal?.aborted ?? false,
    wake = () => {};
  const requestStop = () => {
    stopping = true;
    wake();
  };
  options.signal?.addEventListener("abort", requestStop, { once: true });
  const done = (async () => {
    try {
      while (!stopping) {
        try {
          await options.tick();
        } catch (error) {
          options.onError(error);
        }
        if (!stopping)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, interval);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
      }
    } finally {
      options.signal?.removeEventListener("abort", requestStop);
    }
  })();
  // `stop()` and `done` still expose the original error to a late handler.
  void done.catch(() => {});
  return {
    done,
    stop: () => {
      requestStop();
      return done;
    },
  };
}
