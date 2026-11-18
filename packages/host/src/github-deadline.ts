import { CHECKOUT_LIMITS } from "./checkout-limits.js";

/** Abort cooperative transports AND stop waiting for a stuck response body.
 * Pass the signal to IO and check it before any subsequent side effect.
 */
export async function githubDeadline<T>(
  work: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
  ms: number = CHECKOUT_LIMITS.remoteCommandMs,
): Promise<T> {
  const controller = new AbortController();
  const signal = parent
    ? AbortSignal.any([controller.signal, parent])
    : controller.signal;
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException("GitHub operation timed out", "TimeoutError"),
      ),
    ms,
  );
  try {
    return await Promise.race([stopped, work(signal)]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
