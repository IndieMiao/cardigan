import type { CheckRequest } from "./check-executor.js";
import type { GithubCheckLifecycle } from "./github-check-executor.js";
import { githubCheckScope } from "./github-check-scope.js";
import {
  type GithubClient,
  GithubExecutorError,
  type GithubJob,
  type GithubRun,
} from "./github-client.js";
import type { ExternalGithubRun } from "./github-dispatch-journal.js";
import { GITHUB_POLL_DEFAULTS, GithubRetryLater } from "./github-rate-limit.js";
import type { CheckoutResult } from "./temporary-checkout.js";

export const GITHUB_CHECK_NAMES = [
  "install",
  "build",
  "test",
  "lint",
  "deps",
  "e2e",
] as const;
/** Names supplied by the baseline workflow, independent of candidate code/config. */
export const GITHUB_WORKFLOW_STEPS = [
  "Validate object inputs",
  "Checkout candidate",
  "Verify candidate identity",
  "Setup Node",
  "Enable corepack",
  "Locate pnpm store",
  "Restore dependencies",
  "install",
  "Install and verify hc",
  "build",
  "test",
  "lint",
  "deps",
  "e2e",
] as const;
interface Pending {
  identity: GithubRun;
  external: ExternalGithubRun;
  request: CheckRequest;
  result: Promise<CheckoutResult>;
  resolve: (result: CheckoutResult) => void;
  terminal?: boolean;
  observed?: boolean;
  settledUnconfirmed?: boolean;
  cancelRequested?: boolean;
  cancelled?: boolean;
  cancelWork?: Promise<void> | undefined;
  listed?: boolean;
  failedJob?: number | undefined;
  boundByDispatchId: boolean;
  progress?: string;
  started?: boolean;

  onTerminal?: (() => void) | undefined;
}
const unavailable = (): CheckoutResult => ({
  status: "executor_unreachable",
  checks: [],
  cleanup_errors: [],
  reason: "GitHub 检查身份或步骤无法确认",
});
const rejected = (): CheckoutResult => ({
  status: "failed",
  checks: [],
  cleanup_errors: [],
  reason: "GitHub 检查步骤合同不符，拒绝通过",
});
/** One host-driven maintenance loop per executor. No per-run interval or Agent entry point. */
export class GithubCheckPoller implements GithubCheckLifecycle {
  private readonly pending = new Map<number, Pending>();
  private etag: string | undefined;
  private next = 0;
  private work: Promise<void> | undefined;
  constructor(
    private readonly options: {
      client: Pick<
        GithubClient,
        "pollRuns" | "run" | "jobs" | "cancel" | "jobLog"
      >;
      now?: () => number;
      onError?: (error: GithubExecutorError) => void;
      pollIntervalMs?: number;
      queueWaitMs?: number;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  register(
    external: ExternalGithubRun,
    request: CheckRequest,
    identity: GithubRun,
    onTerminal?: () => void,
    boundByDispatchId = false,
  ): void {
    const previous = this.pending.get(external.run_id);
    if (previous) {
      if (
        JSON.stringify(previous.external) !== JSON.stringify(external) ||
        !sameIdentity(previous.identity, identity, boundByDispatchId) ||
        previous.boundByDispatchId !== boundByDispatchId
      )
        throw new GithubExecutorError("security");
      return;
    }
    let resolve!: Pending["resolve"];
    const result = new Promise<CheckoutResult>((done) => {
      resolve = done;
    });
    this.pending.set(external.run_id, {
      external,
      request,
      identity,
      resolve,
      result,
      onTerminal,
      listed: false,
      boundByDispatchId,
    });
    // A new registration must be observed even if the list's ETag is unchanged.
    this.etag = undefined;
  }
  private state(run: ExternalGithubRun): Pending {
    const state = this.pending.get(run.run_id);
    if (!state || JSON.stringify(state.external) !== JSON.stringify(run))
      throw new GithubExecutorError("security");
    return state;
  }
  poll(run: ExternalGithubRun): Promise<CheckoutResult> {
    const state = this.state(run);
    state.observed = true;
    return state.result.then((result) => {
      if (state.terminal && result.status === "passed")
        this.pending.delete(run.run_id);
      return result;
    });
  }
  async cancel(run: ExternalGithubRun): Promise<void> {
    const state = this.state(run);
    state.cancelRequested = true;
    // Cancellation shares budget/backoff; tick retries until GitHub acknowledges it.
    await this.sendCancel(state);
  }
  private sendCancel(state: Pending): Promise<void> {
    if (state.cancelled || state.terminal) return Promise.resolve();
    if (state.cancelWork) return state.cancelWork;
    state.cancelWork = this.options.client
      .cancel(state.external.run_id)
      .then(() => {
        state.cancelled = true;
      })
      .finally(() => {
        state.cancelWork = undefined;
      });
    return state.cancelWork;
  }
  async fetchFailureLog(run: ExternalGithubRun): Promise<string | undefined> {
    const state = this.state(run);
    if (state.terminal) this.pending.delete(run.run_id);
    return state.failedJob === undefined
      ? undefined
      : this.options.client.jobLog(state.failedJob);
  }

  tick(): Promise<void> {
    // Local start deadlines keep advancing while REST is in Retry-After/budget backoff.
    for (const state of this.pending.values()) {
      if (
        !state.terminal &&
        state.identity.status &&
        state.identity.status !== "completed"
      )
        this.waiting(state, state.identity);
    }
    if (this.work) return this.work;
    if (this.now() < this.next) return Promise.resolve();
    this.next =
      this.now() +
      (this.options.pollIntervalMs ?? GITHUB_POLL_DEFAULTS.pollIntervalMs);
    const work = this.cycle().finally(() => {
      this.work = undefined;
    });
    this.work = work;
    return work;
  }
  private report(error: unknown): void {
    const category =
      error instanceof GithubExecutorError ? error.category : "api";
    try {
      this.options.onError?.(new GithubExecutorError(category));
    } catch {
      /* Diagnostic-only. */
    }
  }
  private deferred(error: unknown): boolean {
    this.etag = undefined;
    if (error instanceof GithubRetryLater) {
      this.next = Math.max(this.next, error.retryAt);
      return true;
    }
    this.report(error);
    return false;
  }
  private async cycle() {
    const active = [...this.pending.values()].filter(
      (state) => !state.terminal,
    );
    if (!active.length) return;
    for (const state of active) {
      if (!state.cancelRequested) continue;
      try {
        await this.sendCancel(state);
      } catch (error) {
        if (this.deferred(error)) return;
      }
    }
    let response: Awaited<ReturnType<GithubClient["pollRuns"]>>;
    try {
      response = await this.options.client.pollRuns(this.etag);
    } catch (error) {
      this.deferred(error);
      return;
    }
    if (!response.unchanged) this.etag = response.etag;
    for (const state of active) {
      try {
        await this.process(state, response);
      } catch (error) {
        if (this.deferred(error)) return;
        if (
          error instanceof GithubExecutorError &&
          error.category === "security"
        )
          this.unconfirmed(state);
      }
    }
  }
  private async process(
    state: Pending,
    response: Awaited<ReturnType<GithubClient["pollRuns"]>>,
  ) {
    if (response.unchanged && state.listed) {
      this.waiting(state, state.identity);
      return;
    }
    const listed = response.unchanged
      ? []
      : response.runs.filter((run) => run?.id === state.external.run_id);
    if (!response.unchanged) state.listed = listed.length === 1;
    if (listed.length > 1) throw new GithubExecutorError("security");
    const run =
      listed[0] ?? (await this.options.client.run(state.external.run_id));
    if (!sameIdentity(state.identity, run, state.boundByDispatchId))
      throw new GithubExecutorError("security");
    if (run.status !== "completed") {
      this.waiting(state, run);
      return;
    }
    state.request.onExecutionStarted?.();
    this.progress(state, "GitHub 检查已结束");
    if (run.conclusion === "cancelled") {
      state.onTerminal?.();
      this.close(state, {
        status: "interrupted",
        checks: [],
        cleanup_errors: [],
      });
      return;
    }
    const jobs = await this.options.client.jobs(run.id);
    const result = mapGithubCheckResult(state.request, run, jobs);
    const failedJob = jobs.find(
      (job) =>
        job &&
        job.run_id === run.id &&
        job.run_attempt === 1 &&
        job.head_sha === run.head_sha &&
        job.conclusion !== "success",
    );
    state.failedJob = failedJob?.id;
    state.onTerminal?.();
    this.close(state, result);
  }
  private waiting(state: Pending, run: GithubRun) {
    if (
      !["queued", "waiting", "pending", "requested", "in_progress"].includes(
        run.status ?? "",
      )
    ) {
      this.unconfirmed(state);
      return;
    }
    const waited = Math.max(0, this.now() - Date.parse(run.created_at));
    if (run.status === "in_progress") {
      state.started = true;
      state.request.onExecutionStarted?.();
    }
    if (
      !state.started &&
      waited >= (this.options.queueWaitMs ?? GITHUB_POLL_DEFAULTS.queueWaitMs)
    ) {
      state.cancelRequested = true;
      const reason = `GitHub 长时间未启动 · 已等 ${Math.floor(waited / 60_000)} 分钟`;
      this.progress(state, reason);
      state.settledUnconfirmed = true;
      state.resolve({
        status: "timed_out",
        checks: [],
        cleanup_errors: ["GitHub 远端结束尚未确认，保留检查占位"],
        reason,
      });
      // Keep tracking the remote run and card reservation until confirmed terminal.
    }
    if (!state.settledUnconfirmed) {
      const progress = state.started
        ? "GitHub 检查执行中"
        : `等待 GitHub 启动 · 已等 ${Math.floor(waited / 60_000)} 分钟`;
      this.progress(state, progress);
    }
    state.identity = run;
  }
  private progress(state: Pending, summary: string) {
    if (state.settledUnconfirmed || state.progress === summary) return;
    try {
      state.request.onProgress?.(summary);
      state.progress = summary;
    } catch (error) {
      // A failed status projection cannot terminate or release remote work.
      this.report(error);
    }
  }
  private unconfirmed(state: Pending) {
    state.cancelRequested = true;
    state.settledUnconfirmed = true;
    state.resolve(unavailable());
  }
  private close(state: Pending, result: CheckoutResult) {
    state.terminal = true;
    state.resolve(result);
    if (!state.observed || state.settledUnconfirmed)
      this.pending.delete(state.external.run_id);
  }
}

function sameIdentity(
  expected: GithubRun,
  actual: GithubRun,
  boundByDispatchId = false,
) {
  const suffix = `@${expected.head_branch}`;
  const path = expected.path.endsWith(suffix)
    ? expected.path.slice(0, -suffix.length)
    : expected.path;
  return (
    (actual.path === path || actual.path === `${path}${suffix}`) &&
    [
      "id",
      "run_attempt",
      "event",
      "head_branch",
      "head_sha",
      "html_url",
      "created_at",
    ].every(
      (key) =>
        expected[key as keyof GithubRun] === actual[key as keyof GithubRun],
    ) &&
    (boundByDispatchId || expected.display_title === actual.display_title) &&
    actual.actor?.login === expected.actor?.login &&
    (actual.triggering_actor === undefined ||
      actual.triggering_actor.login === expected.actor?.login)
  );
}
function mapGithubCheckResult(
  request: CheckRequest,
  run: GithubRun,
  jobs: readonly GithubJob[],
): CheckoutResult {
  if (run.conclusion === "cancelled")
    return { status: "interrupted", checks: [], cleanup_errors: [] };
  const job = jobs[0];
  if (
    jobs.length !== 1 ||
    !job ||
    job.name !== "check" ||
    job.run_id !== run.id ||
    job.run_attempt !== 1 ||
    job.head_sha !== run.head_sha ||
    !Number.isSafeInteger(job.id) ||
    job.id < 1 ||
    job.status !== "completed" ||
    !Array.isArray(job.steps)
  )
    return rejected();
  const mainStepCount =
    GITHUB_WORKFLOW_STEPS.length +
    (job.steps[0]?.name === "Set up job" ? 1 : 0);
  const steps = [...job.steps];
  if (steps[0]?.name === "Set up job") steps.shift();
  if (steps.at(-1)?.name === "Complete job") steps.pop();
  // GitHub registers post steps for these trusted actions, even when skipped.
  for (const name of ["Post Checkout candidate", "Post Setup Node"])
    if (steps.at(-1)?.name === name) steps.pop();
  if (
    steps.length !== GITHUB_WORKFLOW_STEPS.length ||
    steps.some(
      (step, index) => !step || step.name !== GITHUB_WORKFLOW_STEPS[index],
    ) ||
    job.steps.some(
      (step, index) =>
        !step ||
        !Number.isSafeInteger(step.number) ||
        // Main steps are contiguous; GitHub allocates post-action numbers
        // separately, leaving gaps before/between the known cleanup steps.
        (index < mainStepCount
          ? step.number !== index + 1
          : step.number <= (job.steps[index - 1]?.number ?? step.number)) ||
        step.status !== "completed" ||
        !["success", "failure", "timed_out", "skipped", "cancelled"].includes(
          step.conclusion ?? "",
        ),
    ) ||
    request.checks.length !== GITHUB_CHECK_NAMES.length ||
    request.checks.some(
      (step, index) => step.name !== GITHUB_CHECK_NAMES[index],
    )
  )
    return rejected();
  const scope = githubCheckScope(request);
  const intentionalSkip = (name: string) =>
    scope.scope === "docs_only" && scope.skip_checks.split(",").includes(name);
  const checks: CheckoutResult["checks"] = GITHUB_CHECK_NAMES.map((name) => {
    const step = steps.find((step) => step.name === name);
    switch (step?.conclusion) {
      case "success":
        return { name, status: "passed", exit_code: 0 };
      case "failure":
        return { name, status: "failed", exit_code: 1 };
      case "timed_out":
        return { name, status: "timed_out", exit_code: null };
      case "skipped":
        return intentionalSkip(name)
          ? { name, status: "skipped", reason: "docs_only", exit_code: null }
          : { name, status: "not_run", exit_code: null };
      default:
        return { name, status: "interrupted", exit_code: null };
    }
  });
  const passed =
    run.conclusion === "success" &&
    job.conclusion === "success" &&
    job.steps.every(
      (step) =>
        step.conclusion === "success" ||
        (step.conclusion === "skipped" && intentionalSkip(step.name)),
    ) &&
    checks.every(
      (step) => step.status === "passed" || step.status === "skipped",
    );
  return {
    status: passed
      ? "passed"
      : run.conclusion === "timed_out" ||
          checks.some((step) => step.status === "timed_out")
        ? "timed_out"
        : "failed",
    checks,
    cleanup_errors: [],
  };
}

/**
 * Host-only diagnosis using an already trusted run binding and check request.
 * Q-686: business state is read-only; the configured client's existing shared
 * budget journal MUST still account for requests and persist 429 backoff. This
 * can defer other requests on that executor. Never use an independent budget.
 * Does not register/cancel attempts, change execution targets or check results,
 * fetch logs, or persist business state.
 */
export async function inspectGithubCheckRun(options: {
  client: Pick<GithubClient, "run" | "jobs">;
  runId: number;
  expectedRun: GithubRun;
  boundByDispatchId?: boolean;
  request: CheckRequest;
}): Promise<CheckoutResult> {
  const { client, runId, expectedRun, request } = options;
  if (
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    expectedRun.id !== runId ||
    expectedRun.run_attempt !== 1
  )
    return unavailable();
  const run = await client.run(runId);
  if (!sameIdentity(expectedRun, run, options.boundByDispatchId))
    return unavailable();
  if (run.status !== "completed")
    return { ...unavailable(), reason: "GitHub 检查尚未结束，无法核对终态" };
  if (run.conclusion === "cancelled")
    return { status: "interrupted", checks: [], cleanup_errors: [] };
  return mapGithubCheckResult(request, run, await client.jobs(runId));
}
