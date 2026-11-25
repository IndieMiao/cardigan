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

/** Why a progress deadline fired; carried as the abort reason. */
export class GithubProgressTimeout extends DOMException {
  constructor(
    readonly limit: "response" | "idle" | "total",
    readonly ms: number,
  ) {
    super("GitHub operation timed out", "TimeoutError");
  }
}
/** Like githubDeadline, but a streaming body may keep running while bytes
 * arrive: `progress()` renews the idle window, `totalMs` still caps the whole
 * download. Before the first progress call the response window applies.
 */
export async function githubProgressDeadline<T>(
  work: (signal: AbortSignal, progress: () => void) => Promise<T>,
  limits: {
    readonly responseMs: number;
    readonly idleMs: number;
    readonly totalMs: number;
  },
  parent?: AbortSignal,
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
  const fire = (limit: GithubProgressTimeout["limit"], ms: number) =>
    setTimeout(
      () => controller.abort(new GithubProgressTimeout(limit, ms)),
      ms,
    );
  const total = fire("total", limits.totalMs);
  let idle = fire("response", limits.responseMs);
  const progress = () => {
    if (signal.aborted) return;
    clearTimeout(idle);
    idle = fire("idle", limits.idleMs);
  };
  try {
    return await Promise.race([stopped, work(signal, progress)]);
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
    signal.removeEventListener("abort", abort);
  }
}
