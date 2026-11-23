import { expect, test, vi } from "vitest";
import {
  type RepositoryLockKey,
  RepositoryLockTimeoutError,
  repositoryLock,
} from "./lock.js";

const key = (repository: string): RepositoryLockKey => ({
  project_id: "p",
  repository,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("one repository runs one holder at a time, in arrival order", async () => {
  const lock = repositoryLock();
  let active = 0,
    peak = 0;
  const order: number[] = [];
  await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      lock(key("/repos/serial"), async () => {
        active += 1;
        peak = Math.max(peak, active);
        await tick();
        order.push(n);
        active -= 1;
      }),
    ),
  );
  expect(peak).toBe(1);
  expect(order).toEqual([1, 2, 3, 4, 5]);
});

test("different repositories do not wait for each other", async () => {
  const lock = repositoryLock();
  let release!: () => void;
  const held = lock(
    key("/repos/a"),
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  await expect(lock(key("/repos/b"), async () => "b")).resolves.toBe("b");
  release();
  await held;
});

test("separate lock instances share the queue for one repository", async () => {
  let release!: () => void;
  const held = repositoryLock()(
    key("/repos/shared"),
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  const second = repositoryLock({ waitMs: 20 })(
    key("/repos/shared"),
    async () => "never",
  );
  await expect(second).rejects.toBeInstanceOf(RepositoryLockTimeoutError);
  release();
  await held;
});

test("a waiter that times out keeps the queue ordered and the holder keeps working", async () => {
  const lock = repositoryLock({ waitMs: 20 });
  let release!: () => void;
  const steps: string[] = [];
  const held = lock(key("/repos/timeout"), async () => {
    await new Promise<void>((resolve) => (release = resolve));
    steps.push("first");
  });
  const late = lock(key("/repos/timeout"), async () => steps.push("late"));
  await expect(late).rejects.toMatchObject({
    code: "repository_lock_timeout",
  });
  // A later caller with a long wait still runs only after the holder.
  const after = repositoryLock()(key("/repos/timeout"), async () =>
    steps.push("after"),
  );
  release();
  await held;
  await after;
  expect(steps).toEqual(["first", "after"]);
});

test("the cross-process layer gets the remaining wait and is released after the work", async () => {
  const unlock = vi.fn(async () => undefined);
  const acquire = vi.fn(async () => unlock);
  let now = 1_000;
  const lock = repositoryLock({ waitMs: 500, acquire, now: () => now });
  await lock(key("/repos/flock"), async () => {
    expect(unlock).not.toHaveBeenCalled();
    now += 10;
  });
  expect(acquire).toHaveBeenCalledWith(key("/repos/flock"), 500);
  expect(unlock).toHaveBeenCalledOnce();
});

test("a failed cross-process acquire frees the in-process slot", async () => {
  const lock = repositoryLock({
    acquire: async () => {
      throw new RepositoryLockTimeoutError(1);
    },
  });
  await expect(lock(key("/repos/fail"), async () => 1)).rejects.toBeInstanceOf(
    RepositoryLockTimeoutError,
  );
  await expect(
    repositoryLock()(key("/repos/fail"), async () => "ok"),
  ).resolves.toBe("ok");
});

test("work errors release the lock", async () => {
  const lock = repositoryLock();
  await expect(
    lock(key("/repos/error"), async () => {
      throw new Error("git failed");
    }),
  ).rejects.toThrow("git failed");
  await expect(lock(key("/repos/error"), async () => "ok")).resolves.toBe("ok");
});

test("the same repository spelling on different physical machines or projects has independent locks", async () => {
  const lock = repositoryLock({ waitMs: 100 });
  let release!: () => void;
  let acquired!: () => void;
  const ready = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const held = lock(
    { project_id: "p", machine_id: "worker-a", repository: "/worker/repos/p" },
    async () => {
      acquired();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  );
  await ready;
  try {
    expect(
      await lock(
        {
          project_id: "p",
          machine_id: "worker-b",
          repository: "/worker/repos/p",
        },
        async () => "other machine",
      ),
    ).toBe("other machine");
    expect(
      await lock(
        {
          project_id: "q",
          machine_id: "worker-a",
          repository: "/worker/repos/p",
        },
        async () => "other project",
      ),
    ).toBe("other project");
  } finally {
    release();
    await held;
  }
});

test("C-636: every use reports its operation, wait and hold times", async () => {
  let clock = 0;
  const samples: unknown[] = [];
  const lock = repositoryLock({
    waitMs: 1_000,
    now: () => clock,
    acquire: async () => {
      clock += 7; // waiting for the cross-process layer
      return async () => {
        clock += 1; // releasing counts as holding
      };
    },
    observe: (sample) => samples.push(sample),
  });
  await expect(
    lock(
      { ...key("/repos/observed"), operation: "candidate.check" },
      async () => {
        clock += 20;
        return "done";
      },
    ),
  ).resolves.toBe("done");
  const failure = new Error("work failed");
  await expect(
    lock({ ...key("/repos/observed"), machine_id: "mac" }, async () => {
      clock += 3;
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(samples).toEqual([
    {
      project_id: "p",
      machine_id: "local",
      operation: "candidate.check",
      wait_ms: 7,
      hold_ms: 21,
      outcome: "ok",
    },
    {
      project_id: "p",
      machine_id: "mac",
      operation: "unspecified",
      wait_ms: 7,
      hold_ms: 4,
      outcome: "error",
    },
  ]);
});

test("C-636: a wait that ran out is a timeout with no hold; a failing observer changes nothing", async () => {
  const samples: { outcome: string; hold_ms: number; wait_ms: number }[] = [];
  let release!: () => void;
  const held = repositoryLock()(
    key("/repos/observed-timeout"),
    () => new Promise<void>((resolve) => (release = resolve)),
  );
  const waiter = repositoryLock({
    waitMs: 20,
    observe: (sample) => samples.push(sample),
  })({ ...key("/repos/observed-timeout"), operation: "w" }, async () => 1);
  await expect(waiter).rejects.toBeInstanceOf(RepositoryLockTimeoutError);
  expect(samples).toHaveLength(1);
  expect(samples[0]).toMatchObject({ outcome: "timeout", hold_ms: 0 });
  expect(samples[0]?.wait_ms).toBeGreaterThanOrEqual(15);
  // A nested timeout raised by the work itself is the work's error.
  const inner = new RepositoryLockTimeoutError(1);
  await expect(
    repositoryLock({ observe: (sample) => samples.push(sample) })(
      key("/repos/observed-inner"),
      async () => {
        throw inner;
      },
    ),
  ).rejects.toBe(inner);
  expect(samples[1]).toMatchObject({ outcome: "error" });
  release();
  await held;
  const throwing = vi.fn(() => {
    throw new Error("metrics down");
  });
  await expect(
    repositoryLock({ observe: throwing })(
      key("/repos/observed-throwing"),
      async () => "kept",
    ),
  ).resolves.toBe("kept");
  expect(throwing).toHaveBeenCalledOnce();
});
