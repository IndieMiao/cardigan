import { profileTick } from "./tick-profile.js";

/**
 * M4.4: a bounded background loop for the merge, cleanup, reconcile and backup
 * phases. It never installs signal handlers and never owns the store: the
 * caller stops it before closing host resources, and `stop()` waits for the
 * tick that is currently running — SIGTERM must not cut a merge in half.
 */
/** Shared by all loops of one assembled server. False means startup failed. */
export type LoopStartup = Promise<boolean>;
export interface TimerLoopOptions {
  readonly startup?: LoopStartup | undefined;
  readonly name: string;
  readonly tick: () => Promise<void>;
  readonly intervalMs?: number;
  readonly initialDelayMs?: number;
  readonly continueSoon?: () => boolean;
  readonly slowTickMs?: number;
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
export const DEFAULT_SLOW_TICK_MS = 1000;

export function startTimerLoop(options: TimerLoopOptions): TimerLoop {
  const interval = options.intervalMs ?? 600_000;
  if (
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    interval > MAX_INTERVAL
  )
    throw new Error("Invalid loop interval");
  const slowTickMs = options.slowTickMs ?? DEFAULT_SLOW_TICK_MS;
  if (!Number.isFinite(slowTickMs) || slowTickMs <= 0)
    throw new Error("Invalid loop slow tick threshold");
  const initial = options.initialDelayMs ?? 0;
  if (!Number.isSafeInteger(initial) || initial < 0 || initial > MAX_INTERVAL)
    throw new Error("Invalid loop initial delay");
  let stopping = options.signal?.aborted ?? false,
    wake = () => {};
  const requestStop = () => {
    stopping = true;
    wake();
  };
  options.signal?.addEventListener("abort", requestStop, { once: true });
  const delay = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  const done = (async () => {
    try {
      if (
        options.startup &&
        !stopping &&
        !(await Promise.race([
          options.startup,
          new Promise<boolean>((resolve) => {
            wake = () => resolve(false);
          }),
        ]))
      )
        return;
      if (initial && !stopping) await delay(initial);
      while (!stopping) {
        const started = performance.now();
        try {
          await profileTick(options.name, options.tick);
        } catch (error) {
          options.onError(error);
        } finally {
          const elapsed = performance.now() - started;
          if (elapsed > slowTickMs)
            options.onError(
              new Error(
                `${options.name} slow tick: duration_ms=${Math.round(elapsed)} threshold_ms=${slowTickMs}`,
              ),
            );
        }
        if (!stopping)
          await delay(
            options.continueSoon?.() ? Math.min(interval, 250) : interval,
          );
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
