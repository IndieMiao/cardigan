import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { CheckRequest } from "./check-executor.js";
import {
  CASE_RUN_STEP,
  CASE_WORKFLOW_STEPS,
  GITHUB_CHECK_NAMES,
  GITHUB_WORKFLOW_STEPS,
  GithubCheckPoller,
} from "./github-check-poller.js";
import {
  GithubExecutorError,
  type GithubJob,
  GithubLogError,
  GithubNotFoundError,
  type GithubRun,
} from "./github-client.js";
import {
  GITHUB_POLL_DEFAULTS,
  GithubRateLimit,
  GithubRetryLater,
} from "./github-rate-limit.js";
import { createMergeCheckLog } from "./merge-gate-log.js";

const start = Date.parse("2026-11-15T00:00:00Z");
const identity = (id: number): GithubRun => ({
  id,
  run_attempt: 1,
  path: ".github/workflows/check.yml",
  event: "workflow_dispatch",
  head_branch: "main",
  head_sha: "a".repeat(40),
  actor: { login: "fixture[bot]" },
  display_title: `cardigan/C-${id}/D-1/attempt-${id}/merge_check/${"b".repeat(40)}/${"c".repeat(40)}`,
  html_url: `https://github.com/fixture/project/actions/runs/${id}`,
  created_at: new Date(start).toISOString(),
  status: "queued",
  conclusion: null,
});
const external = (id: number) => ({
  provider: "github" as const,
  run_id: id,
  run_attempt: 1 as const,
  html_url: identity(id).html_url,
  workflow_sha: identity(id).head_sha,
});
const request: CheckRequest = {
  project: "p",
  kind: "merge_check",
  sha: "b".repeat(40),
  tree: "c".repeat(40),
  checks: GITHUB_CHECK_NAMES.map((name) => ({ name, run: "true" })),
};
const job = (id: number): GithubJob => ({
  id: id + 1000,
  run_id: id,
  run_attempt: 1,
  head_sha: identity(id).head_sha,
  name: "check",
  status: "completed",
  conclusion: "success",
  steps: [
    "Set up job",
    ...GITHUB_WORKFLOW_STEPS,
    "Post Setup Node",
    "Post Checkout candidate",
    "Complete job",
  ].map((name, index) => ({
    name,
    number: index + 1,
    status: "completed",
    conclusion: "success",
  })),
});
function setup(count = 10, checkRequest: CheckRequest = request) {
  let now = start;
  let runs = Array.from({ length: count }, (_, index) => identity(index + 1));
  const client = {
    pollRuns: vi.fn(async (_etag?: string) => ({
      unchanged: false as boolean,
      runs,
      etag: '"one"',
    })),
    run: vi.fn(async (id: number) => identity(id)),
    jobs: vi.fn(async (id: number) => [job(id)]),
    cancel: vi.fn(async (_id: number) => {}),
    jobLog: vi.fn(async (_id: number, open: () => (text: string) => void) =>
      open()("FAIL synthetic test\nError expected true\n"),
    ),
  };
  const waitForLogRetry = vi.fn(async (_ms: number) => {});
  const poller = new GithubCheckPoller({
    waitForLogRetry,
    client: client as never,
    now: () => now,
  });
  const finished = vi.fn();
  for (const run of runs)
    poller.register(external(run.id), checkRequest, run, finished);
  return {
    poller,
    waitForLogRetry,
    client,
    finished,
    advance: (ms = 20_000) => {
      now += ms;
    },
    complete: () => {
      runs = runs.map((run) => ({
        ...run,
        status: "completed",
        conclusion: "success",
      }));
    },
  };
}
test("D4: ten runs share one conditional list per cycle; 304 does not fetch jobs or drop attempts", async () => {
  const f = setup();
  const results = Array.from({ length: 10 }, (_, i) =>
    f.poller.poll(external(i + 1)),
  );
  await Promise.all([f.poller.tick(), f.poller.tick(), f.poller.tick()]);
  expect(f.client.pollRuns).toHaveBeenCalledOnce();
  expect(f.client.jobs).not.toHaveBeenCalled();
  f.advance();
  f.client.pollRuns.mockResolvedValueOnce({
    unchanged: true,
    runs: [],
    etag: '"one"',
  });
  await f.poller.tick();
  expect(f.client.pollRuns).toHaveBeenLastCalledWith(
    '"one"',
    expect.any(AbortSignal),
  );
  expect(f.client.jobs).not.toHaveBeenCalled();
  f.advance();
  f.complete();
  await f.poller.tick();
  expect((await Promise.all(results)).map((r) => r.status)).toEqual(
    Array(10).fill("passed"),
  );
  expect(f.client.jobs).toHaveBeenCalledTimes(10);
  expect(f.finished).toHaveBeenCalledTimes(10);
});
test("D4: Retry-After pauses all work and retries unchanged terminal runs without losing handles", async () => {
  const f = setup(1);
  f.complete();
  const result = f.poller.poll(external(1));
  f.client.jobs.mockRejectedValueOnce(new GithubRetryLater(start + 60_000));
  await f.poller.tick();
  expect(f.finished).not.toHaveBeenCalled();
  f.advance();
  await f.poller.tick();
  expect(f.client.pollRuns).toHaveBeenCalledOnce();
  f.advance(40_000);
  await f.poller.tick();
  expect((await result).status).toBe("passed");
});
test.each([
  "missing",
  "extra",
  "order",
  "duplicate",
  "job",
  "unknown",
  "attempt",
])("D4: %s step/job evidence fails closed", async (mode) => {
  const f = setup(1);
  f.complete();
  const good = job(1);
  const steps = [...good.steps];
  if (mode === "missing") steps.splice(3, 1);
  if (mode === "extra")
    steps.push({
      name: "evil",
      number: 20,
      status: "completed",
      conclusion: "success",
    });
  if (mode === "order") [steps[8], steps[10]] = [steps[10]!, steps[8]!];
  if (mode === "duplicate") steps[9] = { ...steps[8]! };
  if (mode === "unknown") steps[10] = { ...steps[10]!, conclusion: "neutral" };
  f.client.jobs.mockResolvedValueOnce([
    {
      ...good,
      steps,
      ...(mode === "job" ? { run_id: 2 } : {}),
      ...(mode === "attempt" ? { run_attempt: 2 } : {}),
    },
  ]);
  const result = f.poller.poll(external(1));
  await f.poller.tick();
  expect((await result).status).toBe("failed");
});
test.each(["run_attempt", "head_sha", "display_title", "actor"])(
  "D4: changed %s never passes or releases the durable reservation",
  async (key) => {
    const f = setup(1);
    f.client.pollRuns.mockResolvedValueOnce({
      unchanged: false,
      runs: [
        {
          ...identity(1),
          status: "completed",
          conclusion: "success",
          [key]: key === "actor" ? { login: "evil" } : "evil",
        },
      ],
      etag: "x",
    });
    const result = f.poller.poll(external(1));
    await f.poller.tick();
    expect((await result).status).toBe("executor_unreachable");
    expect(f.finished).not.toHaveBeenCalled();
    expect(f.client.jobs).not.toHaveBeenCalled();
  },
);
test.each([
  "run_attempt",
  "head_sha",
  "actor",
  "created_at",
  "event",
  "path",
  "html_url",
])(
  "C-404: response-ID binding still rejects changed %s after queueing",
  async (key) => {
    const f = setup(0);
    const expected = identity(1);
    f.poller.register(external(1), request, expected, f.finished, true);
    f.client.pollRuns.mockResolvedValue({
      unchanged: false,
      etag: "changed",
      runs: [
        {
          ...expected,
          display_title: "Cardigan check",
          status: "completed",
          conclusion: "success",
          [key]: key === "actor" ? { login: "evil" } : "evil",
        },
      ],
    });
    const result = f.poller.poll(external(1));
    await f.poller.tick();
    expect((await result).status).toBe("executor_unreachable");
    expect(f.finished).not.toHaveBeenCalled();
    expect(f.client.jobs).not.toHaveBeenCalled();
  },
);
test("D4: start timeout requests cancellation, retains reservation until the trusted remote terminal, and does not redispatch", async () => {
  const f = setup(1);
  const result = f.poller.poll(external(1));
  f.advance(3 * 60 * 60_000);
  await f.poller.tick();
  expect(await result).toMatchObject({
    status: "timed_out",
    reason: "GitHub 长时间未启动 · 已等 180 分钟",
  });
  expect(f.finished).not.toHaveBeenCalled();
  f.advance();
  f.client.pollRuns.mockResolvedValueOnce({
    unchanged: false,
    runs: [{ ...identity(1), status: "completed", conclusion: "cancelled" }],
    etag: "x",
  });
  await f.poller.tick();
  expect(f.client.cancel).toHaveBeenCalledWith(1, expect.any(AbortSignal));
  expect(f.finished).toHaveBeenCalledOnce();
});
test.each(["failure", "timed_out", "skipped"])(
  "D4: maps %s steps and downloads only the failed bound job",
  async (conclusion) => {
    const f = setup(1);
    f.complete();
    const good = job(1);
    f.client.jobs.mockResolvedValueOnce([
      {
        ...good,
        conclusion: "failure",
        steps: good.steps.map((step) =>
          step.name === "test" ? { ...step, conclusion } : step,
        ),
      },
    ]);
    const result = f.poller.poll(external(1));
    await f.poller.tick();
    expect(
      (await result).checks.find((step) => step.name === "test")?.status,
    ).toBe(
      conclusion === "failure"
        ? "failed"
        : conclusion === "skipped"
          ? "not_run"
          : "timed_out",
    );
    const write = vi.fn(),
      open = () => write;
    await f.poller.fetchFailureLog(external(1), open);
    expect(write.mock.calls[0]?.[0]).toContain("FAIL");
    expect(f.client.jobLog).toHaveBeenCalledWith(
      1001,
      expect.any(Function),
      undefined,
    );
  },
);
test("D4: shared hourly budget refunds 304, counts details, and enforces Retry-After seconds/date", () => {
  let now = start;
  const rate = new GithubRateLimit(2, () => now);
  const refund = rate.reserve();
  refund();
  rate.reserve();
  rate.reserve();
  expect(() => rate.reserve()).toThrow(GithubRetryLater);
  now += 3_600_000;
  rate.reserve();
  expect(() => rate.backoff("60")).toThrow(GithubRetryLater);
  now += 59_000;
  expect(() => rate.reserve()).toThrow(GithubRetryLater);
  now += 1000;
  rate.reserve();
  expect(() => rate.backoff(new Date(now + 60_000).toUTCString())).toThrow(
    GithubRetryLater,
  );
});

test("D4: bound runs outside the newest list are still read by id after a 304", async () => {
  const f = setup(1);
  f.client.pollRuns.mockResolvedValueOnce({
    unchanged: false,
    runs: [],
    etag: "x",
  });
  await f.poller.tick();
  expect(f.client.run).toHaveBeenCalledWith(1, expect.any(AbortSignal));
  f.advance();
  f.client.pollRuns.mockResolvedValueOnce({
    unchanged: true,
    runs: [],
    etag: "x",
  });
  f.client.run.mockResolvedValueOnce({
    ...identity(1),
    status: "completed",
    conclusion: "success",
  });
  const result = f.poller.poll(external(1));
  await f.poller.tick();
  expect((await result).status).toBe("passed");
  expect(f.client.run).toHaveBeenCalledTimes(2);
});

test("D4: concurrent cancellation coalesces; rate-limited cancellation is retried without abandoning polling", async () => {
  const f = setup(1);
  f.client.cancel.mockRejectedValueOnce(new GithubRetryLater(start + 60_000));
  const first = await Promise.allSettled([
    f.poller.cancel(external(1)),
    f.poller.cancel(external(1)),
  ]);
  expect(first.every((result) => result.status === "rejected")).toBe(true);
  expect(f.client.cancel).toHaveBeenCalledOnce();
  await f.poller.tick();
  expect(f.client.cancel).toHaveBeenCalledTimes(2);
  expect(f.client.pollRuns).toHaveBeenCalledOnce();
});

test("D4: start deadline advances during Retry-After without issuing requests", async () => {
  const f = setup(1);
  const result = f.poller.poll(external(1));
  f.client.pollRuns.mockRejectedValueOnce(
    new GithubRetryLater(start + 4 * 3600_000),
  );
  await f.poller.tick();
  f.advance(3 * 60 * 60_000);
  await f.poller.tick();
  expect(await result).toMatchObject({
    status: "timed_out",
    reason: "GitHub 长时间未启动 · 已等 180 分钟",
  });
  expect(f.client.pollRuns).toHaveBeenCalledOnce();
  expect(f.finished).not.toHaveBeenCalled();
});

test("D4: cancellation rejection does not hide a run that has already completed", async () => {
  const f = setup(1);
  const result = f.poller.poll(external(1));
  f.client.cancel.mockRejectedValue(new Error("fixed API failure"));
  await expect(f.poller.cancel(external(1))).rejects.toThrow();
  f.client.pollRuns.mockResolvedValueOnce({
    unchanged: false,
    runs: [{ ...identity(1), status: "completed", conclusion: "cancelled" }],
    etag: "x",
  });
  await f.poller.tick();
  expect((await result).status).toBe("interrupted");
  expect(f.finished).toHaveBeenCalledOnce();
});

test("D4: log rate limiting cannot delay or replace a verified failed result", async () => {
  const f = setup(1);
  f.complete();
  const good = job(1);
  f.client.jobs.mockResolvedValueOnce([
    {
      ...good,
      conclusion: "failure",
      steps: good.steps.map((step) =>
        step.name === "test" ? { ...step, conclusion: "failure" } : step,
      ),
    },
  ]);
  f.client.jobLog.mockRejectedValueOnce(
    new GithubRetryLater(start + 4 * 3600_000),
  );
  const result = f.poller.poll(external(1));
  await f.poller.tick();
  expect((await result).status).toBe("failed");
  expect(f.finished).toHaveBeenCalledOnce();
  expect(f.client.jobLog).not.toHaveBeenCalled();
  await expect(
    f.poller.fetchFailureLog(external(1), () => vi.fn()),
  ).rejects.toMatchObject({ category: "rate_limited" });
  expect(f.waitForLogRetry).not.toHaveBeenCalled();
  expect(f.client.jobLog).toHaveBeenCalledOnce();
});

test.each(["security", "api"] as const)(
  "D4 rework: a %s fault in the first run reports a fixed category and does not starve a healthy run",
  async (category) => {
    const first = setup(2);
    first.complete();
    const diagnostic = vi.fn();
    const poller = new GithubCheckPoller({
      client: first.client as never,
      now: () => start,
      onError: diagnostic,
    });
    for (const id of [1, 2])
      poller.register(external(id), request, identity(id));
    first.client.jobs.mockImplementation(async (id) => {
      if (id === 1) throw new GithubExecutorError(category);
      return [job(id)];
    });
    const healthy = poller.poll(external(2));
    await poller.tick();
    expect((await healthy).status).toBe("passed");
    expect(first.client.jobs.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    expect(diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        category,
        message: `Check executor unavailable: ${category}`,
      }),
    );
  },
);

test.each(["docs_only", "affected", "full", "legacy"])(
  "scoped mapping preserves the strict step contract for %s",
  async (scope) => {
    const f = setup(0);
    const checks = request.checks.map((check) => ({
      ...check,
      ...(scope === "docs_only" && ["test", "e2e"].includes(check.name)
        ? { skipReason: "docs_only" as const }
        : {}),
      ...(scope === "affected" && check.name === "test"
        ? { affectedPaths: ["apps/web"] }
        : {}),
    }));
    const run = { ...identity(1), status: "completed", conclusion: "success" };
    f.poller.register(external(1), { ...request, checks }, run);
    f.client.run.mockResolvedValueOnce(run);
    const good = job(1);
    f.client.jobs.mockResolvedValueOnce([
      {
        ...good,
        steps: good.steps.map((step) => ({
          ...step,
          conclusion:
            scope === "docs_only" && ["test", "e2e"].includes(step.name)
              ? "skipped"
              : "success",
        })),
      },
    ]);
    const pending = f.poller.poll(external(1));
    await f.poller.tick();
    const result = await pending;
    expect(result.status).toBe("passed");
    expect(result.checks.filter((check) => check.status === "skipped")).toEqual(
      scope === "docs_only"
        ? [
            {
              name: "test",
              status: "skipped",
              reason: "docs_only",
              exit_code: null,
            },
            {
              name: "e2e",
              status: "skipped",
              reason: "docs_only",
              exit_code: null,
            },
          ]
        : [],
    );
  },
);

test.each(["test", "build", "Validate object inputs"])(
  "unexpected skipped %s cannot pass a successful run",
  async (name) => {
    const f = setup(1);
    f.complete();
    const good = job(1);
    f.client.jobs.mockResolvedValueOnce([
      {
        ...good,
        steps: good.steps.map((step) => ({
          ...step,
          conclusion: step.name === name ? "skipped" : "success",
        })),
      },
    ]);
    const pending = f.poller.poll(external(1));
    await f.poller.tick();
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.reason).toBeUndefined();
    if (name === "test")
      expect(result.checks.find((c) => c.name === name)?.status).toBe(
        "not_run",
      );
  },
);

test("C-466: one stuck jobs response does not withhold a verified peer terminal", async () => {
  const f = setup(2);
  f.complete();
  const held = Promise.withResolvers<void>();
  f.client.jobs.mockImplementation(async (id) => {
    if (id === 1) await held.promise;
    return [job(id)];
  });
  const peer = f.poller.poll(external(2));
  const cycle = f.poller.tick();
  try {
    await vi.waitFor(() => expect(f.finished).toHaveBeenCalledOnce());
    expect((await peer).status).toBe("passed");
  } finally {
    held.resolve();
    await cycle;
  }
});

test("C-466: a completed run awaiting jobs cannot time out as queued on an overlapping tick", async () => {
  const f = setup(1);
  const jobs = Promise.withResolvers<GithubJob[]>();
  const reading = Promise.withResolvers<void>();
  f.client.jobs.mockImplementationOnce(() => {
    reading.resolve();
    return jobs.promise;
  });
  f.advance(GITHUB_POLL_DEFAULTS.queueWaitMs - 5000);
  f.complete();
  const result = f.poller.poll(external(1));
  const first = f.poller.tick();
  await reading.promise;
  f.advance(5000);
  const overlapping = f.poller.tick();
  expect(f.finished).not.toHaveBeenCalled();
  jobs.resolve([job(1)]);
  await Promise.all([first, overlapping]);
  expect((await result).status).toBe("passed");
  expect(f.finished).toHaveBeenCalledOnce();
  expect(f.client.cancel).not.toHaveBeenCalled();
});

test("C-466: a slow cancellation leaves later list cycles free to finish another run", async () => {
  const f = setup(2);
  const held = Promise.withResolvers<void>();
  f.client.cancel.mockReturnValueOnce(held.promise);
  const cancel = f.poller.cancel(external(1));
  const first = f.poller.tick();
  try {
    await vi.waitFor(() => expect(f.client.pollRuns).toHaveBeenCalledOnce());
    // Let the first (immediate queued) list finish, not the held cancel.
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.advance();
    f.client.pollRuns.mockResolvedValueOnce({
      unchanged: false,
      runs: [
        identity(1),
        { ...identity(2), status: "completed", conclusion: "success" },
      ],
      etag: "two",
    });
    const result = f.poller.poll(external(2));
    const second = f.poller.tick();
    await vi.waitFor(() => expect(f.finished).toHaveBeenCalledOnce());
    expect((await result).status).toBe("passed");
    expect(f.client.cancel).toHaveBeenCalledTimes(1);
    held.resolve();
    await second;
  } finally {
    held.resolve();
    await Promise.all([first, cancel]);
  }
});

test("C-466: a later list finishes a peer while terminal jobs are still in flight", async () => {
  const f = setup(2);
  const held = Promise.withResolvers<GithubJob[]>();
  f.client.jobs.mockReturnValueOnce(held.promise);
  f.client.pollRuns.mockResolvedValueOnce({
    unchanged: false,
    runs: [
      { ...identity(1), status: "completed", conclusion: "success" },
      identity(2),
    ],
    etag: "first",
  });
  const first = f.poller.tick();
  const peer = f.poller.poll(external(2));
  try {
    await vi.waitFor(() =>
      expect(f.client.jobs).toHaveBeenCalledWith(1, expect.any(AbortSignal)),
    );
    f.advance();
    f.complete();
    const second = f.poller.tick();
    await vi.waitFor(() => expect(f.finished).toHaveBeenCalledOnce());
    expect((await peer).status).toBe("passed");
    expect(f.client.jobs.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    held.resolve([job(1)]);
    await second;
  } finally {
    held.resolve([job(1)]);
    await first;
  }
});

test("C-466: conflicting newer binding evidence fences a late successful jobs response", async () => {
  const f = setup(1);
  f.complete();
  const held = Promise.withResolvers<GithubJob[]>();
  f.client.jobs.mockReturnValueOnce(held.promise);
  const result = f.poller.poll(external(1));
  const first = f.poller.tick();
  try {
    await vi.waitFor(() =>
      expect(f.client.jobs).toHaveBeenCalledWith(1, expect.any(AbortSignal)),
    );
    f.advance();
    f.client.pollRuns.mockResolvedValueOnce({
      unchanged: false,
      runs: [{ ...identity(1), run_attempt: 2 }],
      etag: "rerun",
    });
    await f.poller.tick();
    expect((await result).status).toBe("executor_unreachable");
  } finally {
    held.resolve([job(1)]);
    await first;
  }
  expect(f.finished).not.toHaveBeenCalled();
});

test("C-466: one deadline covers list and jobs; late successful jobs cannot finish the reservation", async () => {
  const f = setup(1);
  f.complete();
  const list = Promise.withResolvers<void>();
  const jobs = Promise.withResolvers<GithubJob[]>();
  const original = f.client.pollRuns.getMockImplementation()!;
  f.client.pollRuns.mockImplementationOnce(async () => {
    await list.promise;
    return original();
  });
  f.client.jobs.mockImplementationOnce(() => jobs.promise);
  vi.useFakeTimers();
  try {
    let settled = false;
    void f.poller.tick().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(50_000);
    list.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.jobs).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(true);
    jobs.resolve([job(1)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.finished).not.toHaveBeenCalled();
    expect(f.client.cancel).not.toHaveBeenCalled();
    f.advance(60_000);
    f.client.pollRuns.mockResolvedValueOnce({
      unchanged: false,
      etag: "new",
      runs: [{ ...identity(1), status: "completed", conclusion: "cancelled" }],
    });
    const result = f.poller.poll(external(1));
    await f.poller.tick();
    expect(await result).toMatchObject({ status: "interrupted" });
    expect(f.finished).toHaveBeenCalledOnce();
  } finally {
    list.resolve();
    jobs.resolve([]);
    vi.useRealTimers();
  }
});

test("C-466: expired list cannot replace a newer ETag or start detail reads", async () => {
  const f = setup(1);
  const late =
    Promise.withResolvers<Awaited<ReturnType<typeof f.client.pollRuns>>>();
  f.client.pollRuns.mockImplementationOnce(() => late.promise);
  vi.useFakeTimers();
  try {
    let settled = false;
    void f.poller.tick().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(true);
    f.advance(60_000);
    await f.poller.tick();
    late.resolve({
      unchanged: false,
      etag: "stale",
      runs: [{ ...identity(1), status: "completed", conclusion: "success" }],
    });
    await vi.advanceTimersByTimeAsync(0);
    f.advance();
    await f.poller.tick();
    expect(f.client.pollRuns.mock.calls.at(-1)?.[0]).toBe('"one"');
    expect(f.client.jobs).not.toHaveBeenCalled();
    expect(f.finished).not.toHaveBeenCalled();
  } finally {
    late.resolve({ unchanged: false, etag: "late", runs: [] });
    vi.useRealTimers();
  }
});

test("C-466: an old jobs timeout cannot clear the ETag from an intervening list", async () => {
  const f = setup(1);
  const held = Promise.withResolvers<GithubJob[]>();
  f.complete();
  f.client.jobs.mockImplementationOnce(() => held.promise);
  vi.useFakeTimers();
  try {
    const slow = f.poller.tick();
    await vi.advanceTimersByTimeAsync(20_000);
    f.advance();
    f.client.pollRuns.mockResolvedValueOnce({
      unchanged: false,
      etag: "fresh",
      runs: [{ ...identity(1), status: "completed", conclusion: "success" }],
    });
    await f.poller.tick();
    await vi.advanceTimersByTimeAsync(40_000);
    await slow;
    f.advance(40_000);
    await f.poller.tick();
    expect(f.client.pollRuns.mock.calls.at(-1)?.[0]).toBe("fresh");
  } finally {
    held.resolve([]);
    vi.useRealTimers();
  }
});

test("V-2081: 304 for a list skipped during backoff cannot certify an older terminal run", async () => {
  const f = setup(2);
  const completed = {
    ...identity(1),
    status: "completed",
    conclusion: "success",
  };
  const rerun = { ...identity(1), run_attempt: 2, status: "in_progress" };
  f.client.pollRuns.mockResolvedValueOnce({
    unchanged: false,
    runs: [completed, identity(2)],
    etag: "a",
  });
  f.client.jobs.mockRejectedValueOnce(new GithubExecutorError("security"));
  await f.poller.tick();
  f.advance();
  f.client.pollRuns.mockResolvedValueOnce({
    unchanged: false,
    runs: [rerun, identity(2)],
    etag: "b",
  });
  await f.poller.tick();
  expect(f.finished).not.toHaveBeenCalled();
  f.advance();
  f.client.run.mockResolvedValueOnce(rerun);
  f.client.pollRuns.mockResolvedValueOnce({
    unchanged: true,
    runs: [],
    etag: "b",
  });
  await f.poller.tick();
  expect(f.finished).not.toHaveBeenCalled();
  expect(f.client.pollRuns.mock.calls.at(-1)?.[0]).toBe("b");
  expect(f.client.run.mock.calls.map(([id]) => id)).toEqual([1]);
  expect(f.client.jobs).toHaveBeenCalledOnce();
  expect(f.client.cancel).not.toHaveBeenCalled();
});

test.each([
  [
    "network",
    [
      new GithubLogError("network", "TypeError: terminated（已接收 1.0 MB）"),
      new GithubLogError(
        "timeout",
        "60 秒未收到新数据（已接收 2.0 MB）",
        "idle",
      ),
      new GithubLogError("network", "TypeError: terminated（已接收 3.0 MB）"),
    ],
    3,
    "TypeError: terminated（已接收 3.0 MB）",
  ],
  [
    "timeout",
    [
      new GithubLogError(
        "timeout",
        "超过下载总时限 900 秒（已接收 3.9 MB）",
        "total",
      ),
    ],
    1,
    "超过下载总时限 900 秒（已接收 3.9 MB）",
  ],
  [
    "http",
    [
      new GithubLogError("http", "HTTP 502"),
      new GithubLogError("http", "HTTP 502"),
      new GithubLogError("http", "HTTP 503"),
    ],
    3,
    "HTTP 503",
  ],
] as const)(
  "C-658: job log %s failures reach the check result with their detail",
  async (category, errors, calls, detail) => {
    const f = setup(1);
    f.complete();
    const j = job(1);
    f.client.jobs.mockResolvedValueOnce([
      {
        ...j,
        conclusion: "failure",
        steps: j.steps.map((s) =>
          s.name === "test" ? { ...s, conclusion: "failure" } : s,
        ),
      },
    ]);
    for (const error of errors) f.client.jobLog.mockRejectedValueOnce(error);
    const terminal = f.poller.poll(external(1));
    await f.poller.tick();
    await terminal;
    await expect(
      f.poller.fetchFailureLog(external(1), () => () => {}),
    ).rejects.toMatchObject({ category, detail });
    expect(f.client.jobLog).toHaveBeenCalledTimes(calls);
  },
);

test.each([true, false])(
  "C-529: retry only the bound job log after a partial download and delayed availability (recovered=%s)",
  async (recovered) => {
    const f = setup(1);
    f.complete();
    const j = job(1);
    f.client.jobs.mockResolvedValueOnce([
      {
        ...j,
        conclusion: "failure",
        steps: j.steps.map((s) =>
          s.name === "test" ? { ...s, conclusion: "failure" } : s,
        ),
      },
    ]);
    f.client.jobLog
      .mockImplementationOnce(async (_id, open) => {
        open()("partial");
        throw new Error("synthetic transport");
      })
      .mockRejectedValueOnce(new GithubNotFoundError());
    if (!recovered)
      f.client.jobLog.mockRejectedValueOnce(new GithubNotFoundError());
    const terminal = f.poller.poll(external(1));
    await f.poller.tick();
    expect(await terminal).toMatchObject({
      status: "failed",
      logSource: { url: external(1).html_url, jobId: j.id },
    });
    let text = "";
    const fetchLog = f.poller.fetchFailureLog(external(1), () => {
      text = "";
      return (chunk) => {
        text += chunk;
      };
    });
    if (recovered) {
      await fetchLog;
      expect(text).toMatch(/^FAIL/u);
    } else
      await expect(fetchLog).rejects.toMatchObject({ category: "not_found" });
    expect(f.waitForLogRetry.mock.calls.map(([ms]) => ms)).toEqual([
      1000, 2000,
    ]);
    expect(f.client.jobLog.mock.calls.map(([id]) => id)).toEqual([
      j.id,
      j.id,
      j.id,
    ]);
    expect(f.finished).toHaveBeenCalledOnce();
  },
);

test.each([
  "passed",
  "failed",
  "partial",
  "missing all",
  "unselected",
  "isolated failed",
  "isolated skipped",
  "isolated timed out",
  "batch timeout",
  "card timeout",
] as const)(
  "case contract is strict, receipts are scoped, batch timeout handling is preserved: %s",
  async (mode) => {
    const timeout = mode.endsWith("timeout");
    const f = setup(1, {
      ...request,
      ...(mode === "batch timeout" ? { mergeTier: "batch" } : {}),
      checks: request.checks.map((check) =>
        check.name === "test" && mode === "unselected"
          ? { ...check, affectedPaths: ["apps/web"] }
          : check,
      ),
    });
    f.complete();
    const j = job(1);
    const names = CASE_WORKFLOW_STEPS.filter(
      (name) =>
        !(mode === "missing all" && name.startsWith("Recovered ")) &&
        !(mode === "partial" && name === "Recovered loopback"),
    );
    const conclusion = (name: string) => {
      if (name.startsWith("Recovered "))
        return name === "Recovered corepack" && !timeout
          ? "success"
          : "skipped";
      if (name === "test" && (timeout || mode === "failed")) return "failure";
      if (name === CASE_RUN_STEP) {
        if (mode === "isolated failed") return "failure";
        if (mode === "isolated skipped") return "skipped";
        if (mode === "isolated timed out") return "timed_out";
      }
      return "success";
    };
    const steps = names.map((name, i) => ({
      name,
      number: i + 1,
      status: "completed",
      conclusion: conclusion(name),
    }));
    f.client.jobs.mockResolvedValueOnce([{ ...j, steps }]);
    const result = f.poller.poll(external(1));
    await f.poller.tick();
    const settled = await result;
    if (mode === "passed" || mode === "failed")
      expect(settled).toMatchObject({ status: mode, recovered: ["corepack"] });
    else if (mode === "isolated failed")
      expect(settled).toMatchObject({
        status: "failed",
        failedGithubStep: CASE_RUN_STEP,
        recovered: ["corepack"],
      });
    else if (timeout) {
      expect(settled.status).toBe("failed");
      const dataDir = await mkdtemp(join(tmpdir(), "case-contract-timeout-"));
      try {
        const log = await createMergeCheckLog({
          dataDir,
          project: "p",
          attempt: "timeout",
        });
        log.append(
          "test",
          " FAIL src/check.test.ts > slow test\nError: Test timed out in 5000ms.\n",
        );
        expect((await log.finish(settled)).timeout_only).toBe(
          mode === "batch timeout",
        );
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
      expect(settled.recovered).toBeUndefined();
    } else {
      expect(settled).toMatchObject({ status: "failed", checks: [] });
      expect(settled.recovered).toBeUndefined();
    }
    expect(f.client.jobLog).not.toHaveBeenCalled();
  },
);

test("C-658: generic provider diagnostics still never reach the log failure", async () => {
  const f = setup(1);
  f.complete();
  const j = job(1);
  f.client.jobs.mockResolvedValueOnce([
    {
      ...j,
      conclusion: "failure",
      steps: j.steps.map((s) =>
        s.name === "test" ? { ...s, conclusion: "failure" } : s,
      ),
    },
  ]);
  const auth = new GithubExecutorError("auth");
  auth.diagnostic = "do-not-record-provider-detail";
  f.client.jobLog.mockRejectedValueOnce(auth);
  const terminal = f.poller.poll(external(1));
  await f.poller.tick();
  await terminal;
  const error = await f.poller
    .fetchFailureLog(external(1), () => () => {})
    .catch((e: unknown) => e);
  expect(error).toMatchObject({ category: "auth" });
  expect((error as { detail?: string }).detail).toBeUndefined();
});
