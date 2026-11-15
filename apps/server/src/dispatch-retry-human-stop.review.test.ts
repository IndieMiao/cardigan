import { stoppedByHuman, stopWorkItemAssignment } from "@cardigan/domain";
import { listBellAttempts } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";

test("a human stop during retry preparation must prevent the queued bell", async () => {
  const f = recoveryFixture();
  let unblock = () => {};
  let enter = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const beforeWake = vi.fn(async () => {
    enter();
    await blocked;
  });
  let retrying: Promise<void> | undefined;
  try {
    f.comment();
    // The initial delivery fails before any wake. Its dispatched Run is now
    // eligible for the existing C-56 backoff path, with no remote activity.
    await new Dispatcher({
      ...f.options,
      beforeWake: async () => {
        throw new Error("fixture preparation failure");
      },
    }).tick();
    const run = f.latest();
    expect(run.status).toBe("dispatched");
    expect(f.runtime.wake).not.toHaveBeenCalled();
    expect(listBellAttempts(f.store.database, f.project)).toMatchObject([
      { run_id: run.id, outcome: "failed" },
    ]);
    f.advance(30000);
    retrying = new Dispatcher({ ...f.options, beforeWake }).tick();
    await entered;
    f.apply((state, actor, ports) =>
      stopWorkItemAssignment(
        state,
        actor,
        {
          assignment_id: f.target.assignment.id,
          reason: "human stopped retry preparation",
        },
        ports,
      ),
    );
    expect(stoppedByHuman(f.state().events, f.target.assignment.id)).toBe(true);
    expect(f.latest().status).toBe("dispatched");
    unblock();
    await retrying;
    const observed = {
      humanStopped: stoppedByHuman(f.state().events, f.target.assignment.id),
      preparationCalls: beforeWake.mock.calls.length,
      wakeCalls: vi.mocked(f.runtime.wake).mock.calls.length,
      runStatus: f.latest().status,
      attemptOutcomes: listBellAttempts(f.store.database, f.project).map(
        (a) => a.outcome,
      ),
      notificationStatuses: f.notes().map((n) => n.status),
    };
    console.log(JSON.stringify(observed));
    expect(
      f.runtime.wake,
      "a persisted human stop must fence retry delivery too",
    ).not.toHaveBeenCalled();
    expect(observed.attemptOutcomes).toEqual(["failed"]);
    expect(observed.notificationStatuses).toEqual(["delivery_failed"]);
    await new Dispatcher({ ...f.options, beforeWake }).tick();
    expect(beforeWake).toHaveBeenCalledOnce();
    expect(f.runtime.wake).not.toHaveBeenCalled();
  } finally {
    unblock();
    await retrying;
    f.close();
  }
});
