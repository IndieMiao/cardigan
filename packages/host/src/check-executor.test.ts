import { expect, test, vi } from "vitest";
import { type CheckRequest, SshCheckExecutor } from "./check-executor.js";
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
