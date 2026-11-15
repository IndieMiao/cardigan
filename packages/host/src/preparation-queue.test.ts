import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { preparationBudget } from "./preparation-budget.js";
import {
  preparationBusy,
  preparationPolicy,
  withPreparationQueue,
} from "./preparation-queue.js";
import {
  acquireRepositoryFlock,
  type FlockRunner,
  hostRepositoryLock,
} from "./repository-lock.js";

afterEach(() => vi.restoreAllMocks());
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("Q-475 defaults and malformed host configuration", () => {
  expect(preparationPolicy({})).toEqual({
    maxConcurrent: 2,
    queueWaitMs: 300000,
    retryBackoffMs: 5000,
  });
  for (const name of [
    "CARDIGAN_PREPARATION_CONCURRENCY",
    "CARDIGAN_PREPARATION_QUEUE_WAIT_MS",
    "CARDIGAN_PREPARATION_RETRY_BACKOFF_MS",
  ])
    for (const value of ["0", "-1", "NaN", "1.5", "2147483648"])
      expect(() => preparationPolicy({ [name]: value })).toThrow(name);
});

test("ten preparations use two slots, retain FIFO per repository and let other repositories advance", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-prep-queue-"));
  const gates = Array.from({ length: 10 }, deferred);
  const starts: number[] = [];
  let active = 0,
    peak = 0;
  const tasks = Array.from({ length: 10 }, (_, i) =>
    withPreparationQueue(root, `repo-${i % 2}`, async () => {
      starts.push(i);
      peak = Math.max(peak, ++active);
      const gate = gates[i];
      if (!gate) throw new Error("Missing gate");
      await gate.promise;
      active--;
      return i;
    }),
  );
  try {
    await expect.poll(() => starts.length).toBe(2);
    expect(await preparationBusy(root)).toBe(true);
    for (let i = 0; i < 10; i += 2) {
      await expect.poll(() => starts.length).toBe(i + 2);
      expect(starts.slice(i, i + 2).sort((a, b) => a - b)).toEqual([i, i + 1]);
      gates[i]?.resolve();
      gates[i + 1]?.resolve();
    }
    expect(await Promise.all(tasks)).toEqual(
      Array.from({ length: 10 }, (_, i) => i),
    );
    expect(peak).toBe(2);
    expect(await preparationBusy(root)).toBe(false);
  } finally {
    for (const gate of gates) gate.resolve();
    await Promise.allSettled(tasks);
    await rm(root, { recursive: true, force: true });
  }
});

test("queue expiry does not start abandoned work or release the current holder", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-prep-expiry-"));
  const gate = deferred(),
    entered = deferred();
  const policy = { maxConcurrent: 1, queueWaitMs: 40, retryBackoffMs: 1 };
  const first = withPreparationQueue(
    root,
    "a",
    async () => {
      entered.resolve();
      await gate.promise;
    },
    policy,
  );
  await entered.promise;
  const work = vi.fn();
  try {
    await expect(
      withPreparationQueue(root, "b", work, policy),
    ).rejects.toMatchObject({ code: "preparation_queue_timeout" });
    expect(work).not.toHaveBeenCalled();
    expect(await preparationBusy(root)).toBe(true);
  } finally {
    gate.resolve();
    await first;
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")(
  "a different process occupying slot zero leaves slot one available",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cg-prep-external-"));
    const release = await acquireRepositoryFlock(
      join(root, "locks", "preparation-0.lock"),
      1000,
    );
    try {
      await expect(
        withPreparationQueue(root, "p", async () => "ready", {
          maxConcurrent: 2,
          queueWaitMs: 1000,
          retryBackoffMs: 1,
        }),
      ).resolves.toBe("ready");
    } finally {
      await release();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "a timed-out repository wait exhausts the shared budget before any short retry",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cg-prep-exhausted-"));
    const run = vi.fn<FlockRunner>(async () => 1);
    const lock = hostRepositoryLock(root, { run });
    const key = { project_id: "p", repository: join(root, "repo") };
    const work = vi.fn();
    try {
      await preparationBudget.run({ remaining: 100 }, async () => {
        await expect(lock(key, work)).rejects.toMatchObject({
          code: "preparation_queue_timeout",
        });
        expect(preparationBudget.getStore()?.remaining).toBe(0);
        await expect(lock(key, work)).rejects.toMatchObject({
          code: "preparation_queue_timeout",
        });
      });
      expect(run).toHaveBeenCalledOnce();
      expect(work).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform !== "linux")(
  "one shared budget covers successive repository waits but excludes work time",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cg-prep-budget-"));
    let time = 0;
    vi.spyOn(performance, "now").mockImplementation(() => time);
    const run = vi.fn<FlockRunner>(async () => {
      time += 20;
      return 0;
    });
    const lock = hostRepositoryLock(root, { run });
    try {
      await preparationBudget.run({ remaining: 100 }, async () => {
        await lock(
          { project_id: "p", repository: join(root, "repo") },
          async () => {
            time += 1000;
          },
        );
        expect(preparationBudget.getStore()?.remaining).toBe(80);
        await lock(
          { project_id: "p", repository: join(root, "repo") },
          async () => undefined,
        );
        expect(preparationBudget.getStore()?.remaining).toBe(60);
      });
      if (process.platform === "linux")
        expect(run.mock.calls.map(([args]) => args[2])).toEqual([
          "0.100",
          "0.080",
        ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
