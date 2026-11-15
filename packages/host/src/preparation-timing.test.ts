import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CentralRepositoryService,
  GitWorktreeService,
  repositoryLock,
} from "@cardigan/git-service";
import {
  CentralGitTransport,
  LocalGitTransport,
} from "@cardigan/git-transport";
import { afterEach, expect, test, vi } from "vitest";

const sha = "a".repeat(40);
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
afterEach(() => vi.useRealTimers());

// C-295 investigation: exercise the existing lock and transport boundary with
// virtual time, never real Git/SSH or a burst of actual Agent processes.
test("ten preparation queries wait FIFO outside the Git command budget", async () => {
  vi.useFakeTimers();
  const lock = repositoryLock({ waitMs: 1_000 });
  const started: number[] = [];
  const budgets: number[] = [];
  const transport = new LocalGitTransport(
    "git",
    { queryTimeoutMs: 30 },
    {
      run: async (_args, timeout) => {
        started.push(Date.now());
        budgets.push(timeout);
        await delay(10);
        return sha;
      },
    },
  );
  const order: number[] = [];
  const queued = Date.now();
  const results = Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      lock({ project_id: "p", repository: "/fixture/fifo" }, async () => {
        order.push(index);
        return transport.resolveCommit("/fixture/fifo", sha);
      }),
    ),
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(await results).toEqual(Array(10).fill(sha));
  expect(order).toEqual(Array.from({ length: 10 }, (_, index) => index));
  expect(started.map((time) => time - queued)).toEqual(
    Array.from({ length: 10 }, (_, index) => index * 10),
  );
  expect(budgets).toEqual(Array(10).fill(30));
});

test("repository wait expiry never starts the queued Git command", async () => {
  vi.useFakeTimers();
  const lock = repositoryLock({ waitMs: 40 });
  const key = { project_id: "p", repository: "/fixture/expiry" };
  const holder = lock(key, () => delay(80));
  const run = vi.fn(async () => sha);
  const transport = new LocalGitTransport(
    "git",
    { queryTimeoutMs: 30 },
    { run },
  );
  const waiting = expect(
    lock(key, () => transport.resolveCommit(key.repository, sha)),
  ).rejects.toMatchObject({ code: "repository_lock_timeout" });
  await vi.advanceTimersByTimeAsync(40);
  await waiting;
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(40);
  await holder;
});

test("different repositories can enter ten workspace executors simultaneously", async () => {
  vi.useFakeTimers();
  const lock = repositoryLock({ waitMs: 1_000 });
  let active = 0,
    peak = 0;
  const transport = new LocalGitTransport(
    "git",
    { queryTimeoutMs: 30 },
    {
      run: async () => {
        peak = Math.max(peak, ++active);
        await delay(10);
        active -= 1;
        return sha;
      },
    },
  );
  const results = Promise.all(
    Array.from({ length: 10 }, (_, index) => {
      const repository = `/fixture/project-${index}`;
      return lock({ project_id: `p-${index}`, repository }, () =>
        transport.resolveCommit(repository, sha),
      );
    }),
  );
  await vi.advanceTimersByTimeAsync(10);
  expect(await results).toEqual(Array(10).fill(sha));
  expect(peak).toBe(10);
});

test("build checkout listing enters workspace Git while preparation owns the repository lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "cg-preparation-timing-"));
  const repository = join(root, "agent", "repos", "p");
  await mkdir(repository, { recursive: true });
  const lock = vi.fn(repositoryLock());
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = lock({ project_id: "p", repository }, async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  await ready;
  try {
    const run = vi.fn(
      async () =>
        `worktree ${join(root, "agent", "builds", "p", "A-1")}\0HEAD ${sha}\0detached\0\0`,
    );
    const service = new GitWorktreeService(
      new LocalGitTransport("git", { queryTimeoutMs: 30 }, { run }),
      new CentralRepositoryService(new CentralGitTransport({ dataDir: root }), {
        dataDir: root,
      }),
      { dataDir: root, lock },
    );
    await expect(service.listBuildCheckouts("p")).resolves.toEqual(["A-1"]);
    expect(run).toHaveBeenCalledWith(
      expect.arrayContaining(["worktree", "list"]),
      30,
    );
    // Only the explicit preparation holder took the lock; listing bypassed it.
    expect(lock).toHaveBeenCalledOnce();
  } finally {
    release();
    await held;
    await rm(root, { recursive: true, force: true });
  }
});
