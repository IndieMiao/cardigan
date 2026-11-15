import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import type { CheckRequest } from "./check-executor.js";
import {
  GITHUB_CHECK_NAMES,
  GithubCheckPoller,
  inspectGithubCheckRun,
} from "./github-check-poller.js";
import type { GithubJob, GithubRun } from "./github-client.js";

const samples = [
  {
    id: 43716549498,
    hash: "11f573048e10d3110c93b00231d195a89ec83cea6c82e75f55647d6741896aa0",
    sha: "975af0c152e37e927bbae26aa134340e927c73fc",
    conclusion: "success",
    statuses: ["passed", "passed", "passed", "passed", "passed", "passed"],
  },
  {
    id: 43731282724,
    hash: "4db11ec60d36cd1c800abacb94bec147ecfb1d05d3baf47d6acf97711289817b",
    sha: "63b0b9b415cdd3c9f77641452bce58f14ecb44ea",
    conclusion: "failure",
    statuses: ["passed", "passed", "failed", "not_run", "not_run", "not_run"],
  },
] as const;
const request: CheckRequest = {
  project: "fixture",
  kind: "merge_check",
  sha: "b".repeat(40),
  tree: "c".repeat(40),
  checks: GITHUB_CHECK_NAMES.map((name) => ({ name, run: "true" })),
};
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("Missing fixture item");
  return value;
}
function fixture(sample: (typeof samples)[number] = samples[0]) {
  const bytes = readFileSync(
    new URL(
      `./__fixtures__/github-jobs-${sample.id}.json.fixture`,
      import.meta.url,
    ),
  );
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(sample.hash);
  const body = JSON.parse(bytes.toString("utf8")) as {
    total_count: number;
    jobs: GithubJob[];
  };
  expect(body.total_count).toBe(1);
  // The attachments are jobs responses only. Run/binding evidence below is
  // synthetic and independent; this does not certify either real run's trust.
  const expectedRun: GithubRun = {
    id: sample.id,
    run_attempt: 1,
    path: ".github/workflows/check.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: sample.sha,
    actor: { login: "fixture[bot]" },
    display_title: `cardigan/C-1/D-1/fixture/merge_check/${request.sha}/${request.tree}`,
    html_url: `https://github.com/fixture/project/actions/runs/${sample.id}`,
    created_at: "2026-11-15T00:00:00Z",
  };
  const client = {
    run: vi.fn(
      async (_id: number): Promise<GithubRun> => ({
        ...expectedRun,
        status: "completed",
        conclusion: sample.conclusion,
      }),
    ),
    jobs: vi.fn(
      async (_id: number): Promise<readonly GithubJob[]> => body.jobs,
    ),
    pollRuns: vi.fn(async () => ({ unchanged: false, runs: [] })),
    cancel: vi.fn(async () => {}),
    jobLog: vi.fn(async () => ""),
  };
  return {
    client,
    expectedRun,
    jobs: body.jobs,
    inspect: (checks = request.checks) =>
      inspectGithubCheckRun({
        client,
        runId: sample.id,
        expectedRun,
        request: { ...request, checks },
      }),
  };
}

test.each(samples)(
  "C-367: original jobs $id map identically in diagnosis and polling",
  async (sample) => {
    const f = fixture(sample);
    const diagnostic = await f.inspect();
    expect(diagnostic.status).toBe(
      sample.conclusion === "success" ? "passed" : "failed",
    );
    expect(diagnostic.reason).toBeUndefined();
    expect(diagnostic.checks.map((check) => check.status)).toEqual(
      sample.statuses,
    );
    expect(diagnostic.checks.map((check) => check.name)).toEqual(
      GITHUB_CHECK_NAMES,
    );
    expect(f.client.run).toHaveBeenCalledExactlyOnceWith(sample.id);
    expect(f.client.jobs).toHaveBeenCalledExactlyOnceWith(sample.id);
    expect(f.client.pollRuns).not.toHaveBeenCalled();
    expect(f.client.cancel).not.toHaveBeenCalled();
    expect(f.client.jobLog).not.toHaveBeenCalled();

    const external = {
      provider: "github" as const,
      run_id: sample.id,
      run_attempt: 1 as const,
      html_url: f.expectedRun.html_url,
      workflow_sha: f.expectedRun.head_sha,
    };
    const poller = new GithubCheckPoller({ client: f.client });
    poller.register(external, request, f.expectedRun);
    const result = poller.poll(external);
    await poller.tick();
    expect(await result).toEqual(diagnostic);
  },
);

test("C-367: known cleanup steps may have gaps between each other", async () => {
  const f = fixture();
  f.client.jobs.mockResolvedValueOnce([
    {
      ...at(f.jobs, 0),
      steps: at(f.jobs, 0).steps.map((step, index) => ({
        ...step,
        number: index < 15 ? step.number : at([29, 40, 99], index - 15),
      })),
    },
  ]);
  expect((await f.inspect()).status).toBe("passed");
});

test.each([
  "missing",
  "renamed",
  "order",
  "main_gap",
  "main_start",
  "duplicate",
  "unknown_tail",
  "duplicate_tail",
  "tail_order",
  "tail_equal_main",
  "tail_duplicate_number",
  "tail_descending",
  "tail_zero",
  "tail_negative",
  "tail_fraction",
  "tail_unsafe",
  "tail_nan",
  "tail_infinity",
  "tail_string",
  "step_running",
  "step_conclusion",
  "job_attempt",
  "job_sha",
  "job_run",
  "job_running",
  "job_name",
  "job_missing",
  "job_extra",
  "check_names",
])("C-367: %s still rejects the step contract", async (mode) => {
  const f = fixture();
  const job = at(f.jobs, 0);
  const steps = job.steps.map((step) => ({ ...step }));
  const jobs = [{ ...job, steps }];
  if (mode === "missing") steps.splice(3, 1);
  if (mode === "renamed") at(steps, 3).name = "Other identity";
  if (mode === "order") [steps[3], steps[4]] = [at(steps, 4), at(steps, 3)];
  if (mode === "main_gap") at(steps, 14).number = 16;
  if (mode === "main_start") at(steps, 0).number = 2;
  if (mode === "duplicate") steps[4] = { ...at(steps, 3) };
  if (mode === "unknown_tail") at(steps, 15).name = "Post unknown";
  if (mode === "duplicate_tail")
    steps.splice(16, 0, { ...at(steps, 15), number: 30 });
  if (mode === "tail_order")
    [steps[15], steps[16]] = [at(steps, 16), at(steps, 15)];
  const badNumbers: Record<string, unknown> = {
    tail_equal_main: 15,
    tail_duplicate_number: 30,
    tail_descending: 32,
    tail_zero: 0,
    tail_negative: -1,
    tail_fraction: 29.5,
    tail_unsafe: Number.MAX_SAFE_INTEGER + 1,
    tail_nan: Number.NaN,
    tail_infinity: Number.POSITIVE_INFINITY,
    tail_string: "29",
  };
  if (mode in badNumbers) at(steps, 15).number = badNumbers[mode] as number;
  if (mode === "step_running") at(steps, 15).status = "in_progress";
  if (mode === "step_conclusion") at(steps, 15).conclusion = "neutral";
  if (mode === "job_attempt") at(jobs, 0).run_attempt = 2;
  if (mode === "job_sha") at(jobs, 0).head_sha = "d".repeat(40);
  if (mode === "job_run") at(jobs, 0).run_id++;
  if (mode === "job_running") at(jobs, 0).status = "in_progress";
  if (mode === "job_name") at(jobs, 0).name = "other";
  if (mode === "job_missing") jobs.pop();
  if (mode === "job_extra") jobs.push({ ...at(jobs, 0) });
  f.client.jobs.mockResolvedValueOnce(jobs);
  const result = await f.inspect(mode === "check_names" ? [] : request.checks);
  expect(result).toMatchObject({
    status: "failed",
    checks: [],
    reason: expect.stringContaining("合同不符"),
  });
});

test.each([
  "run_attempt",
  "head_sha",
  "path",
  "event",
  "head_branch",
  "actor",
  "triggering_actor",
  "display_title",
  "id",
])("C-367: changed run %s is unconfirmed without reading jobs", async (key) => {
  const f = fixture();
  const run = await f.client.run(f.expectedRun.id);
  f.client.run.mockClear().mockResolvedValueOnce({
    ...run,
    [key]:
      key === "actor" || key === "triggering_actor"
        ? { login: "other" }
        : key === "run_attempt"
          ? 2
          : key === "id"
            ? 123
            : "other",
  });
  expect(await f.inspect()).toMatchObject({
    status: "executor_unreachable",
    checks: [],
    reason: expect.any(String),
  });
  expect(f.client.jobs).not.toHaveBeenCalled();
});

test("C-367: diagnosis never waits, cancels, or maps unfinished/cancelled runs to success", async () => {
  const f = fixture();
  f.client.run.mockResolvedValueOnce({
    ...f.expectedRun,
    status: "in_progress",
    conclusion: null,
  });
  expect(await f.inspect()).toMatchObject({
    status: "executor_unreachable",
    reason: expect.stringContaining("尚未结束"),
  });
  f.client.run.mockResolvedValueOnce({
    ...f.expectedRun,
    status: "completed",
    conclusion: "cancelled",
  });
  expect(await f.inspect()).toMatchObject({
    status: "interrupted",
    checks: [],
  });
  expect(f.client.jobs).not.toHaveBeenCalled();
  expect(f.client.cancel).not.toHaveBeenCalled();
});

test.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, 123])(
  "C-367: invalid or unbound run id %s makes no API request",
  async (runId) => {
    const f = fixture();
    expect(
      await inspectGithubCheckRun({
        client: f.client,
        runId,
        expectedRun: f.expectedRun,
        request,
      }),
    ).toMatchObject({ status: "executor_unreachable" });
    expect(f.client.run).not.toHaveBeenCalled();
    expect(f.client.jobs).not.toHaveBeenCalled();
  },
);
