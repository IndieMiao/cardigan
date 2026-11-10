import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { standingResolver } from "./assembly.js";
import { Dispatcher } from "./dispatch.js";

let f: ReturnType<typeof recoveryFixture>;
beforeEach(() => {
  f = recoveryFixture();
});
afterEach(() => f.close());

const events = (type: string) =>
  f.state().events.filter((e) => e.type === type);

test("a beforeWake that keeps failing never leaves the Run in dispatched: C-56 retries and recovers it", async () => {
  const logged: string[] = [];
  const beforeWake = vi.fn(async () => {
    // What withPreparationRetry throws after its own 1/2/4 s attempts.
    throw Object.assign(new Error("Command failed: git fetch"), {
      code: 128,
      stderr:
        "fatal: Unable to create '/data/agent/repos/p/.git/shallow.lock': File exists.",
    });
  });
  const dispatcher = () =>
    new Dispatcher({
      ...f.options,
      standing: standingResolver(f.store),
      beforeWake,
      onError: (error) => logged.push((error as Error).message),
    });
  f.comment();
  await dispatcher().tick();
  const original = f.latest();
  expect(original.status).toBe("dispatched");
  for (const delay of [30_000, 60_000, 120_000, 240_000]) {
    f.advance(delay);
    await dispatcher().tick();
  }
  // The first delivery and each of the 4 backoff retries ran Git preparation
  // once (its 1/2/4 s short retry lives inside beforeWake), never rang the
  // bell, and kept the real cause on the card.
  expect(beforeWake).toHaveBeenCalledTimes(5);
  expect(f.runtime.wake).not.toHaveBeenCalled();
  const attempts = events("bell_delivery_attempt_failed");
  expect(attempts).toHaveLength(5);
  for (const e of attempts)
    expect(e.payload).toMatchObject({
      run_id: original.id,
      reason: "before_wake_failed",
      error: { category: "git_lock_conflict", exit_code: 128 },
    });
  expect(
    logged.filter((l) => l.includes("reason=before_wake_failed")),
  ).toHaveLength(5);
  expect(events("bell_delivery_failed")).toEqual([]);
  // Retry exhaustion: the stuck Run is stopped, cancelled and requeued once.
  await dispatcher().tick();
  expect(f.state().runs.find((r) => r.id === original.id)?.status).toBe(
    "cancelled",
  );
  expect(events("run_dispatch_recovered")).toHaveLength(1);
  expect(f.latest().id).not.toBe(original.id);
  expect(
    f
      .state()
      .runs.filter((r) => r.status === "dispatched" && r.id === original.id),
  ).toEqual([]);
});
