import { expect, test, vi } from "vitest";
import {
  CheckExecutorSuspended,
  type CheckRequest,
  runCheckExecutor,
  SshCheckExecutor,
} from "./check-executor.js";
import { CHECKOUT_LIMITS } from "./checkout-limits.js";
import type { CheckoutInput, CheckoutResult } from "./temporary-checkout.js";

const result: CheckoutResult = {
  status: "passed",
  checks: [{ name: "test", status: "passed", exit_code: 0 }],
  cleanup_errors: [],
};
const request = (kind: CheckRequest["kind"]): CheckRequest => ({
  kind,
  project: "fixture",
  attempt: "attempt-1",
  sha: "a".repeat(40),
  tree: "b".repeat(40),
  checks: [{ name: "test", run: "true" }],
  serialize: true,
  lockSlot: 2,
});

test("C-404: waiting does not consume execution time; repeated start and late progress cannot extend it", async () => {
  vi.useFakeTimers();
  try {
    let received: CheckRequest | undefined;
    const onProgress = vi.fn();
    const cancel = vi.fn(async () => {});
    const executionMs = 60 * 60_000;
    const work = runCheckExecutor(
      {
        startupTimeoutMs: 3 * executionMs,
        dispatch: async (input) => {
          received = input;
          input.onReady?.();
          return { id: "test" };
        },
        poll: () => new Promise<CheckoutResult>(() => {}),
        cancel,
        fetchFailureLog: async () => undefined,
      },
      { ...request("precheck"), totalTimeoutMs: executionMs, onProgress },
      vi.fn(),
    );
    await vi.advanceTimersByTimeAsync(70 * 60_000);
    expect(cancel).not.toHaveBeenCalled();
    received?.onExecutionStarted?.();
    await vi.advanceTimersByTimeAsync(executionMs - 1);
    received?.onExecutionStarted?.();
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 + CHECKOUT_LIMITS.graceMs);
    expect((await work).status).toBe("timed_out");
    expect(cancel).toHaveBeenCalledOnce();
    received?.onProgress?.("late progress");
    expect(onProgress).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test.each(["merge_check", "precheck"] as const)(
  "D1: %s dispatch preserves supervisor inputs, readiness and streamed logs",
  async (kind) => {
    let distributed = false;
    const onReady = vi.fn(),
      onOutput = vi.fn(),
      onRegistered = vi.fn();
    const input = { ...request(kind), onReady, onOutput, onRegistered };
    const execution = { mode: "local" as const, dataDir: "/synthetic" };
    const run = vi.fn(async (received: CheckoutInput) => {
      expect(distributed).toBe(true);
      expect(received).toMatchObject({
        execution,
        project: input.project,
        attempt: input.attempt,
        sha: input.sha,
        tree: input.tree,
        checks: input.checks,
        serialize: true,
        lockSlot: 2,
      });
      expect(received).not.toHaveProperty("kind");
      received.onReady?.();
      received.onOutput?.("test", "synthetic output");
      return result;
    });
    const executor = new SshCheckExecutor({
      execution,
      distribute: async () => {
        distributed = true;
      },
      run,
    });
    const handle = await executor.dispatch(input);
    expect(await executor.poll(handle)).toEqual(result);
    expect(await executor.fetchFailureLog(handle)).toBeUndefined();
    expect(onReady).toHaveBeenCalledOnce();
    expect(onOutput).toHaveBeenCalledWith("test", "synthetic output");
    expect(run).toHaveBeenCalledOnce();
  },
);

test("D1: cancellation reaches supervisor; foreign handles never resolve or cancel a run", async () => {
  const executor = new SshCheckExecutor({
    execution: { mode: "local", dataDir: "/synthetic" },
    distribute: async () => {},
    run: (input) =>
      new Promise((resolve) => {
        input.signal?.addEventListener(
          "abort",
          () => resolve({ ...result, status: "interrupted", checks: [] }),
          { once: true },
        );
      }),
  });
  const handle = await executor.dispatch(request("merge_check"));
  await executor.cancel(handle);
  expect((await executor.poll(handle)).status).toBe("interrupted");
  expect(() => executor.poll({ id: handle.id })).toThrow(
    "Unknown check execution handle",
  );
  await expect(executor.cancel({ id: handle.id })).rejects.toThrow(
    "Unknown check execution handle",
  );
  await expect(executor.fetchFailureLog({ id: handle.id })).rejects.toThrow(
    "Unknown check execution handle",
  );
});

test("D1 rework: broken diagnostic consumers cannot replace the trusted terminal result", async () => {
  const terminal: CheckoutResult = {
    ...result,
    status: "timed_out",
    checks: [{ name: "test", status: "timed_out", exit_code: null }],
    cleanup_errors: ["synthetic cleanup retained"],
  };
  const executor = {
    dispatch: async () => ({ id: "fixture" }),
    poll: async () => terminal,
    cancel: async () => {},
    fetchFailureLog: async () => {
      throw new Error("token=synthetic-secret");
    },
  };
  const report = vi.fn((_error: Error) => {
    throw new Error("synthetic reporter unavailable");
  });
  expect(
    await runCheckExecutor(
      executor,
      {
        ...request("merge_check"),
        onOutput: () => {
          throw new Error("synthetic logger unavailable");
        },
      },
      report,
    ),
  ).toBe(terminal);
  expect(report).toHaveBeenCalledOnce();
  expect(report.mock.calls[0]?.[0]).toMatchObject({
    message: "检查失败日志获取失败，保留原执行结果与清理提示",
  });
});

test.each(["dispatch", "poll"])(
  "D4 rework: host suspension during %s detaches without cancelling remote or publishing late callbacks",
  async (phase) => {
    const host = new AbortController();
    let ready!: (value: { id: string }) => void;
    let complete!: (value: CheckoutResult) => void;
    let received: CheckRequest | undefined;
    const dispatch = new Promise<{ id: string }>((resolve) => {
      ready = resolve;
    });
    const poll = new Promise<CheckoutResult>((resolve) => {
      complete = resolve;
    });
    const executor = {
      dispatch: vi.fn(async (input: CheckRequest) => {
        received = input;
        if (phase === "poll") ready({ id: "remote" });
        return dispatch;
      }),
      poll: vi.fn(async () => poll),
      cancel: vi.fn(async () => {}),
      fetchFailureLog: vi.fn(async () => {}),
    };
    const onReady = vi.fn(),
      onVerifiedCheckout = vi.fn(),
      onOutput = vi.fn();
    const work = runCheckExecutor(
      executor,
      {
        ...request("merge_check"),
        hostSignal: host.signal,
        onReady,
        onVerifiedCheckout,
        onOutput,
      },
      vi.fn(),
    );
    await vi.waitFor(() => expect(executor.dispatch).toHaveBeenCalledOnce());
    if (phase === "poll")
      await vi.waitFor(() => expect(executor.poll).toHaveBeenCalledOnce());
    const rejected = expect(work).rejects.toBeInstanceOf(
      CheckExecutorSuspended,
    );
    host.abort();
    await rejected;
    ready({ id: "remote" });
    complete(result);
    received?.onVerifiedCheckout?.({ kind: "verified_checkout" });
    received?.onReady?.();
    received?.onOutput?.("test", "late");
    await Promise.resolve();
    await Promise.resolve();
    expect(executor.cancel).not.toHaveBeenCalled();
    expect(onVerifiedCheckout).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(onOutput).not.toHaveBeenCalled();
  },
);
