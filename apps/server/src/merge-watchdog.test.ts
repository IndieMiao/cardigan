import { createHostOpsAssignment, HOST_OPS_ROLE_TOOLS } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { MergeExecutor, startMergeLoop } from "./merge-loop.js";
import { withPublication } from "./publication-lock.js";

test.each([true, false])(
  "C-466: a stuck scheduler emits one durable notice before returning (ops=%s)",
  async (hasOps) => {
    const f = recoveryFixture();
    const ops = hasOps
      ? (() => {
          f.store.uow.run((tx) =>
            tx.roles.put(f.project, {
              role_id: "host_ops",
              role_version: 1,
              allowed_tools: HOST_OPS_ROLE_TOOLS,
              capabilities: [],
            }),
          );
          return f.apply((s, a, p) => createHostOpsAssignment(s, a, {}, p))
            .assignment;
        })()
      : undefined;
    const held = Promise.withResolvers<void>();
    const pass = vi
      .spyOn(MergeExecutor.prototype, "schedule")
      .mockImplementation(async () => {
        await held.promise;
        return { done: Promise.resolve() };
      });
    vi.useFakeTimers();
    const { loop } = startMergeLoop({
      store: f.store,
      git: {} as never,
      intervalMs: 100,
      watchdogMs: 50,
    });
    const incidents = () =>
      f.state().events.filter((e) => e.type === "merge_loop_stalled");
    try {
      await vi.advanceTimersByTimeAsync(49);
      expect(incidents()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(151);
      expect(incidents()).toHaveLength(1);
      expect(
        f.store
          .listNotifications({ project_id: f.project })
          .filter((n) => n.event_id === incidents()[0]?.id),
      ).toMatchObject([
        {
          recipient: ops
            ? { kind: "assignment", assignment_id: ops.id }
            : { kind: "pm_ops" },
          status: "pending",
        },
      ]);
      expect(pass).toHaveBeenCalledOnce();
      held.resolve();
      await vi.advanceTimersByTimeAsync(301);
      expect(pass.mock.calls.length).toBeGreaterThan(1);
      expect(incidents()).toHaveLength(1);
    } finally {
      held.resolve();
      await loop.stop();
      pass.mockRestore();
      vi.useRealTimers();
      f.close();
    }
  },
);

test("C-466: an expired publication waiter never publishes late or releases the live holder", async () => {
  const held = Promise.withResolvers<void>();
  const write = vi.fn(async () => {});
  vi.useFakeTimers();
  const holder = withPublication("fixture", () => held.promise);
  try {
    const expired = expect(withPublication("fixture", write)).rejects.toThrow(
      "lock wait timed out",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await expired;
    const next = withPublication("fixture", write);
    expect(write).not.toHaveBeenCalled();
    held.resolve();
    await next;
    expect(write).toHaveBeenCalledOnce();
  } finally {
    held.resolve();
    await holder;
    vi.useRealTimers();
  }
});
