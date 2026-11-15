import { CHECKOUT_LIMITS } from "./checkout-limits.js";
import type { CheckoutInput, CheckoutResult } from "./temporary-checkout.js";

/** Host polling stops without cancelling a durable remote execution. */
export class CheckExecutorSuspended extends Error {
  constructor() {
    super("Check supervision suspended");
  }
}
/** A controller must recover even when an executor ignores cancellation or never settles. */
export async function withCheckoutDeadline<
  T extends Omit<CheckoutInput, "execution">,
>(
  input: T,
  run: (input: T) => Promise<CheckoutResult>,
  hostSignal?: AbortSignal,
): Promise<CheckoutResult> {
  if (hostSignal?.aborted) throw new CheckExecutorSuspended();
  const abort = new AbortController();
  let closed = false,
    ready = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  const deadline = new Promise<CheckoutResult>((resolve) => {
    const expire = () => {
      closed = true;
      abort.abort();
      resolve({
        status: input.signal?.aborted
          ? "interrupted"
          : ready
            ? "timed_out"
            : "executor_unreachable",
        checks: [],
        cleanup_errors: ["检查执行器未在宽限时间内结束，远端清理未确认"],
        reason: "检查超过主机总时限及宽限时间，已释放执行通道",
      });
    };
    timer = setTimeout(
      expire,
      Math.min(
        2147483647,
        (input.totalTimeoutMs ?? 60 * 60_000) + CHECKOUT_LIMITS.graceMs,
      ),
    );
    onAbort = () => {
      abort.abort();
      clearTimeout(timer);
      timer = setTimeout(expire, CHECKOUT_LIMITS.graceMs);
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();
  });
  let onSuspend: () => void = () => {};
  const suspended = new Promise<never>((_resolve, reject) => {
    onSuspend = () => {
      closed = true;
      reject(new CheckExecutorSuspended());
    };
    hostSignal?.addEventListener("abort", onSuspend, { once: true });
    if (hostSignal?.aborted) onSuspend();
  });
  try {
    return await Promise.race([
      deadline,
      suspended,
      // Late callbacks cannot reacquire capacity, append to a closed log or publish a result.
      run({
        ...input,
        signal: abort.signal,
        onReady: (owner) => {
          if (!closed) {
            ready = true;
            input.onReady?.(owner);
          }
        },
        ...(input.onVerifiedCheckout
          ? {
              onVerifiedCheckout: (
                context: Parameters<
                  NonNullable<CheckoutInput["onVerifiedCheckout"]>
                >[0],
              ) => {
                if (!closed) input.onVerifiedCheckout?.(context);
              },
            }
          : {}),
        onOutput: (name, text) => {
          if (!closed) input.onOutput?.(name, text);
        },
        ...(input.onRegistered
          ? {
              onRegistered: (
                binding: Parameters<
                  NonNullable<CheckoutInput["onRegistered"]>
                >[0],
              ) => {
                if (!closed) input.onRegistered?.(binding);
              },
            }
          : {}),
      }),
    ]);
  } finally {
    closed = true;
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
    hostSignal?.removeEventListener("abort", onSuspend);
  }
}
