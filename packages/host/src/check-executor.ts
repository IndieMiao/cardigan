import { randomUUID } from "node:crypto";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import { withCheckoutDeadline } from "./checkout-deadline.js";
import {
  type CheckoutInput,
  type CheckoutResult,
  runInTemporaryCheckout,
} from "./temporary-checkout.js";

/** Trusted host requests only; prechecks never become merge-check records. */
export interface CheckRequest extends Omit<CheckoutInput, "execution"> {
  readonly kind: "merge_check" | "precheck";
}
/** Provider-private state is held by the executor, never by domain events. */
export interface CheckHandle {
  readonly id: string;
}
export interface CheckExecutor {
  dispatch(request: CheckRequest): Promise<CheckHandle>;
  /** Long poll: resolves at a terminal result, without controller busy polling. */
  poll(handle: CheckHandle): Promise<CheckoutResult>;
  cancel(handle: CheckHandle): Promise<void>;
  /** Raw private output; consumers must use the host log redactor. */
  fetchFailureLog(handle: CheckHandle): Promise<string | undefined>;
}

/** Existing SSH/local supervisor, including its deadline and exit/cleanup protocol. */
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
    const abort = new AbortController();
    const handle = { id: randomUUID() };
    const result = withCheckoutDeadline(
      {
        ...input,
        execution: this.options.execution,
        signal: request.signal
          ? AbortSignal.any([request.signal, abort.signal])
          : abort.signal,
      },
      this.options.run ?? runInTemporaryCheckout,
    );
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
