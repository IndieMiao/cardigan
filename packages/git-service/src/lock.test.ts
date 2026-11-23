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

test("C-638: each use reports its operation, wait and hold separately", async () => {
  let now = 0;
  const samples: unknown[] = [];
  const acquire = vi.fn(async () => {
    now += 30; // waiting on the cross-process lock
    return async () => undefined;
  });
  const lock = repositoryLock({
    acquire,
    now: () => now,
    observe: (sample) => samples.push(sample),
  });
  await lock(
    { ...key("/repos/timed"), operation: "candidate_push" },
    async () => {
      now += 200;
    },
  );
  await expect(
    lock(key("/repos/timed"), async () => {
      now += 5;
      throw new Error("work failed");
    }),
  ).rejects.toThrow("work failed");
  expect(samples).toEqual([
    {
      project_id: "p",
      operation: "candidate_push",
      wait_ms: 30,
      hold_ms: 200,
      outcome: "held",
    },
    {
      project_id: "p",
      operation: "unspecified",
      wait_ms: 30,
      hold_ms: 5,
      outcome: "held",
    },
  ]);
});

test("C-638: a lock never held reports its wait and why, and a throwing observer changes nothing", async () => {
  const samples: { outcome: string; hold_ms?: number }[] = [];
  const timeout = repositoryLock({
    acquire: async () => {
      throw new RepositoryLockTimeoutError(1);
    },
    observe: (sample) => samples.push(sample),
  });
  await expect(
    timeout(key("/repos/never"), async () => 1),
  ).rejects.toBeInstanceOf(RepositoryLockTimeoutError);
  const broken = repositoryLock({
    acquire: async () => {
      throw new Error("flock exited with 2");
    },
    observe: (sample) => samples.push(sample),
  });
  await expect(broken(key("/repos/never"), async () => 1)).rejects.toThrow(
    "flock exited",
  );
  expect(samples.map((s) => [s.outcome, s.hold_ms])).toEqual([
    ["timeout", undefined],
    ["failed", undefined],
  ]);
  const throwing = repositoryLock({
    observe: () => {
      throw new Error("observer");
    },
  });
  await expect(throwing(key("/repos/never"), async () => "ok")).resolves.toBe(
    "ok",
  );
});
