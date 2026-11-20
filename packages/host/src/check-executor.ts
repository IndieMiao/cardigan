import { randomUUID } from "node:crypto";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import { withCheckoutDeadline } from "./checkout-deadline.js";
import {
  type CheckoutInput,
  type CheckoutResult,
  runInTemporaryCheckout,
} from "./temporary-checkout.js";

export {
  CandidateRepositoryBusy,
  CheckExecutorSuspended,
} from "./checkout-deadline.js";

/** Fixed provider categories only; raw transport errors must not cross this boundary. */
export class CheckExecutorUnavailable extends Error {
  /** Only a redacted, bounded host diagnostic may be attached here. */
  diagnostic?: string;
  constructor(
    readonly category:
      | "auth"
      | "api"
      | "security"
      | "recovery_incomplete"
      | "dispatch_unknown"
      | "card_busy",
  ) {
    super(`Check executor unavailable: ${category}`);
  }
}
/** Trusted host requests only; prechecks never become merge-check records. */
export interface CheckRequest extends Omit<CheckoutInput, "execution"> {
  readonly mergeTier?: "card" | "batch";
  readonly kind: "merge_check" | "precheck";
  /** Recheck scheduling after asynchronous preparation, immediately before execution. */
  readonly beforeDispatch?: () => void | Promise<void>;
  /** Host shutdown detaches supervision; business cancellation continues to use signal. */
  readonly hostSignal?: AbortSignal;
  /** Trusted provider progress; never candidate output. */
  readonly onProgress?: (summary: string) => void;
  readonly onExecutionStarted?: () => void;
}
/** Provider-private state is held by the executor, never by domain events. */
export interface CheckHandle {
  readonly id: string;
}
export interface CheckExecutor {
  /** Additional startup budget; execution gets its original deadline on start. */
  readonly startupTimeoutMs?: number;
  dispatch(request: CheckRequest): Promise<CheckHandle>;
  /** Long poll: resolves at a terminal result, without controller busy polling. */
  poll(handle: CheckHandle): Promise<CheckoutResult>;
  cancel(handle: CheckHandle): Promise<void>;
  /** Raw private output; consumers must use the host log redactor. */
  fetchFailureLog(handle: CheckHandle): Promise<string | undefined>;
}

/** Provider-independent deadline, cancellation and late-callback fence. */
export async function runCheckExecutor(
  executor: CheckExecutor,
  request: CheckRequest,
  onError: (error: Error) => void,
): Promise<CheckoutResult> {
  let closed = false;
  let polled: CheckoutResult | undefined;
  const diagnostic = (message: string) => {
    // Provider errors may contain credentials or transport details. Only this
    // fixed host diagnostic goes to either the reporter or the private log.
    try {
      request.onOutput?.("executor-log", message);
    } catch {
      // Log delivery is diagnostic-only too.
    }
    try {
      onError(new Error(message));
    } catch {
      // A failed reporter cannot replace the supervisor's result either.
    }
  };
  try {
    const result = await withCheckoutDeadline(
      request,
      async (input) => {
        let executing = true;
        const handle = await executor.dispatch({
          ...input,
          onProgress: (summary) => {
            if (executing && !closed && !input.signal?.aborted)
              input.onProgress?.(summary);
          },
          // Poll completion ends provider callbacks, even while diagnostics are
          // still downloading. Downloaded text uses the guarded host input below.
          onReady: (owner) => {
            if (executing) input.onReady?.(owner);
          },
          ...(input.onVerifiedCheckout
            ? {
                onVerifiedCheckout: (
                  context: Parameters<
                    NonNullable<CheckRequest["onVerifiedCheckout"]>
                  >[0],
                ) => {
                  if (executing) input.onVerifiedCheckout?.(context);
                },
              }
            : {}),
          onOutput: (name, text) => {
            if (executing) input.onOutput?.(name, text);
          },
          ...(input.onRegistered
            ? {
                onRegistered: (
                  binding: Parameters<
                    NonNullable<CheckRequest["onRegistered"]>
                  >[0],
                ) => {
                  if (executing) input.onRegistered?.(binding);
                },
              }
            : {}),
        });
        const cancel = () => {
          if (request.hostSignal?.aborted) return;
          void Promise.resolve()
            .then(() => executor.cancel(handle))
            .catch(() => {
              if (!closed) diagnostic("检查执行器取消请求失败，远端清理未确认");
            });
        };
        input.signal?.addEventListener("abort", cancel, { once: true });
        if (input.signal?.aborted || closed) cancel();
        try {
          // A late dispatch still needs cancelling, but cannot start another poll.
          if (input.signal?.aborted || closed)
            return { status: "interrupted", checks: [], cleanup_errors: [] };
          const terminal = await executor.poll(handle);
          executing = false;
          if (input.signal?.aborted || closed) return terminal;
          polled = terminal;
          if (terminal.status !== "passed") {
            try {
              const failure = await executor.fetchFailureLog(handle);
              if (!closed && !input.signal?.aborted && failure !== undefined)
                input.onOutput?.(
                  terminal.checks.find(
                    (step) =>
                      !["passed", "not_run", "skipped"].includes(step.status),
                  )?.name ?? "executor",
                  failure,
                );
            } catch {
              if (!closed && !input.signal?.aborted)
                diagnostic("检查失败日志获取失败，保留原执行结果与清理提示");
            }
          }
          return terminal;
        } finally {
          executing = false;
          input.signal?.removeEventListener("abort", cancel);
        }
      },
      request.hostSignal,
      executor.startupTimeoutMs,
    );
    // Downloading diagnostics is subordinate to an already trusted terminal
    // result. A stuck download is bounded by the same deadline as execution.
    if (polled && result !== polled) {
      diagnostic("检查失败日志获取超时或取消，保留原执行结果与清理提示");
      return polled;
    }
    return result;
  } catch (error) {
    if (!(error instanceof CheckExecutorUnavailable)) throw error;
    const reason = `检查执行器不可用：${error.category}${error.diagnostic ? ` (${error.diagnostic})` : ""}`;
    diagnostic(reason);
    return {
      status: "executor_unreachable",
      checks: [],
      cleanup_errors: [],
      reason,
    };
  } finally {
    closed = true;
  }
}

/** Existing SSH/local supervisor; the common runner supplies the deadline. */
export class SshCheckExecutor implements CheckExecutor {
  private readonly runs = new WeakMap<
    CheckHandle,
    { abort: AbortController; result: Promise<CheckoutResult> }
  >();
  constructor(
    private readonly options: {
      execution: ExecutionConfig;
      distribute: () => Promise<void>;
      run?: typeof runInTemporaryCheckout;
    },
  ) {}
  async dispatch(request: CheckRequest): Promise<CheckHandle> {
    await this.options.distribute();
    const { kind: _kind, ...input } = request;
    await request.beforeDispatch?.();
    const abort = new AbortController();
    const handle = { id: randomUUID() };
    const result = (this.options.run ?? runInTemporaryCheckout)({
      ...input,
      execution: this.options.execution,
      signal: request.signal
        ? AbortSignal.any([request.signal, abort.signal])
        : abort.signal,
    });
    // Dispatch and poll are separate calls; retain rejection for poll without
    // exposing an unhandled rejection if cancellation happens in between.
    void result.catch(() => {});
    this.runs.set(handle, { abort, result });
    return handle;
  }
  poll(handle: CheckHandle): Promise<CheckoutResult> {
    return this.run(handle).result;
  }
  async cancel(handle: CheckHandle): Promise<void> {
    this.run(handle).abort.abort();
  }
  async fetchFailureLog(handle: CheckHandle): Promise<undefined> {
    this.run(handle);
    // SSH streams through onOutput; fetching it again would duplicate output.
    return undefined;
  }
  private run(handle: CheckHandle) {
    const run = this.runs.get(handle);
    if (!run) throw new Error("Unknown check execution handle");
    return run;
  }
}
