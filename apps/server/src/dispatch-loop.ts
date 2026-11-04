import type { Dispatcher } from "./dispatch.js";

export interface DispatchLoopOptions {
  dispatcher: Pick<Dispatcher, "tick">;
  /** RuntimeMonitor implements this lifecycle; assembly remains in M3.5. */
  monitor?: { reconcile(): void; stop(): Promise<void> };
  intervalMs?: number;
  signal?: AbortSignal;
  /** Tick failures are reported and retried on the next interval; throwing stops the loop. */
  onError(error: unknown): void;
}
export interface DispatchLoop {
  readonly done: Promise<void>;
  /** Idempotent: stop scheduling, drain the current delivery, then close subscriptions. */
  stop(): Promise<void>;
}

/** No global signal handlers or Store ownership. Await stop() before closing host resources. */
export function startDispatchLoop(options: DispatchLoopOptions): DispatchLoop {
  const interval = options.intervalMs ?? 1000;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > 2147483647)
    throw new Error("Invalid dispatcher interval");
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
          options.monitor?.reconcile();
          await options.dispatcher.tick();
          if (!stopping) options.monitor?.reconcile();
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
      await options.monitor?.stop();
    }
  })();
  // stop()/done still expose the original error, even if shutdown attaches its handler later.
  void done.catch(() => {});
  return {
    done,
    stop: () => {
      requestStop();
      return done;
    },
  };
}
