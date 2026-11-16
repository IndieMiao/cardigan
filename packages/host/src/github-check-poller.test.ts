import { expect, test, vi } from "vitest";
import type { CheckRequest } from "./check-executor.js";
import {
  GITHUB_CHECK_NAMES,
  GITHUB_WORKFLOW_STEPS,
  GithubCheckPoller,
} from "./github-check-poller.js";
import {
  GithubExecutorError,
  type GithubJob,
  type GithubRun,
} from "./github-client.js";
import { GithubRateLimit, GithubRetryLater } from "./github-rate-limit.js";

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
function setup(count = 10) {
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
    jobLog: vi.fn(
      async (_id: number) => "FAIL synthetic test\nError expected true\n",
    ),
  };
  const poller = new GithubCheckPoller({
    client: client as never,
    now: () => now,
  });
  const finished = vi.fn();
  for (const run of runs)
    poller.register(external(run.id), request, run, finished);
  return {
    poller,
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
  expect(f.client.pollRuns).toHaveBeenLastCalledWith('"one"');
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
test("D4: start timeout requests cancellation, retains reservation until the trusted remote terminal, and does not redispatch", async () => {
  const f = setup(1);
  const result = f.poller.poll(external(1));
  f.advance(15 * 60_000);
  await f.poller.tick();
  expect((await result).status).toBe("executor_unreachable");
  expect(f.finished).not.toHaveBeenCalled();
  f.advance();
  f.client.pollRuns.mockResolvedValueOnce({
    unchanged: false,
    runs: [{ ...identity(1), status: "completed", conclusion: "cancelled" }],
    etag: "x",
  });
  await f.poller.tick();
  expect(f.client.cancel).toHaveBeenCalledWith(1);
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
    expect(await f.poller.fetchFailureLog(external(1))).toContain("FAIL");
    expect(f.client.jobLog).toHaveBeenCalledWith(1001);
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
  expect(f.client.run).toHaveBeenCalledWith(1);
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
    new GithubRetryLater(start + 3600_000),
  );
  await f.poller.tick();
  f.advance(15 * 60_000);
  await f.poller.tick();
  expect((await result).status).toBe("executor_unreachable");
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
  f.client.jobLog.mockRejectedValueOnce(new GithubRetryLater(start + 3600_000));
  const result = f.poller.poll(external(1));
  await f.poller.tick();
  expect((await result).status).toBe("failed");
  expect(f.finished).toHaveBeenCalledOnce();
  expect(f.client.jobLog).not.toHaveBeenCalled();
  await expect(f.poller.fetchFailureLog(external(1))).rejects.toBeInstanceOf(
    GithubRetryLater,
  );
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
