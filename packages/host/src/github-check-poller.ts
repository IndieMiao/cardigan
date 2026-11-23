import { setTimeout as delay } from "node:timers/promises";
import {
  type CheckRequest,
  FailureLogError,
  type OpenFailureLog,
} from "./check-executor.js";
import { checkFlakeCases, checkFlakeIds } from "./check-flake-cases.js";
import type { GithubCheckLifecycle } from "./github-check-executor.js";
import { githubCheckScope } from "./github-check-scope.js";
import {
  type GithubClient,
  GithubExecutorError,
  type GithubJob,
  GithubLogError,
  GithubNotFoundError,
  type GithubRun,
} from "./github-client.js";
import { githubDeadline } from "./github-deadline.js";
import type {
  ExternalGithubRun,
  RetryBinding,
} from "./github-dispatch-journal.js";
import {
  GITHUB_POLL_DEFAULTS,
  GithubRetryLater,
  type MaintenanceRetry,
  nextMaintenanceRetry,
} from "./github-rate-limit.js";
import {
  compareGithubStepContract,
  describeGithubStepMatcher,
  GITHUB_CHECK_NAMES,
  GITHUB_COMPLETE_STEP,
  GITHUB_SETUP_STEP,
  type GithubStepContract,
  type GithubStepShape,
  githubStepShape,
} from "./github-step-contract.js";
import type { CheckoutResult } from "./temporary-checkout.js";

export { GITHUB_CHECK_NAMES };
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
// A renamed mandatory step identifies the new contract independently of
// optional diagnostics. Losing even all receipt steps cannot look like v1.
export const CASE_SCOPE_STEP = "Verify candidate identity and case scope";
export const CASE_RUN_STEP = "Run isolated case files";
export const CASE_WORKFLOW_STEPS = GITHUB_WORKFLOW_STEPS.flatMap(
  (step): string[] =>
    step === "Verify candidate identity"
      ? [CASE_SCOPE_STEP]
      : step === "build"
        ? [CASE_RUN_STEP, ...checkFlakeIds.map((id) => `Recovered ${id}`), step]
        : [step],
);
// GitHub registers post steps for these trusted actions, even when skipped.
const CARDIGAN_POST_STEPS = [
  { name: "Post Setup Node" },
  { name: "Post Checkout candidate" },
];
/** Cardigan's own workflow, used when an executor configures no contract. */
const CARDIGAN_CONTRACT: GithubStepContract = {
  steps: GITHUB_WORKFLOW_STEPS.map((name) => ({ name })),
  postSteps: CARDIGAN_POST_STEPS,
};
const CARDIGAN_CASE_CONTRACT: GithubStepContract = {
  steps: CASE_WORKFLOW_STEPS.map((name) => ({ name })),
  postSteps: CARDIGAN_POST_STEPS,
};
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
  reading?: Promise<void> | undefined;
  revision: number;
  retry?: MaintenanceRetry | undefined;
  binding?: RetryBinding | undefined;
  listed?: { etag: string; run: GithubRun };
  failedJob?: number | undefined;
  logSteps?: GithubJob["steps"];
  /** C-661: a contract rejection's diagnostic, written as the failure log. */
  rejection?: string | undefined;
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
export const GITHUB_CONTRACT_REJECTED = "GitHub 检查步骤合同不符，拒绝通过";
const rejected = (detail: string): CheckoutResult => ({
  status: "failed",
  checks: [],
  cleanup_errors: [],
  reason: `${GITHUB_CONTRACT_REJECTED}：${detail}`,
});
const MAX_SHOWN_NAME = 120;
/** GitHub step names come from the baseline workflow; bound them for display. */
const shown = (name: unknown): string =>
  typeof name !== "string"
    ? "（无）"
    : name.length > MAX_SHOWN_NAME
      ? `${name.slice(0, MAX_SHOWN_NAME).replace(/[\p{Cc}\p{Cf}]/gu, "?")}…`
      : name.replace(/[\p{Cc}\p{Cf}]/gu, "?");
/** One host-driven maintenance loop per executor. No per-run interval or Agent entry point. */
export class GithubCheckPoller implements GithubCheckLifecycle {
  private readonly pending = new Map<number, Pending>();
  private etag: string | undefined;
  private next = 0;
  private listing: Promise<{ done: Promise<void> }> | undefined;
  constructor(
    private readonly options: {
      client: Pick<
        GithubClient,
        "pollRuns" | "run" | "jobs" | "cancel" | "jobLog"
      >;
      now?: () => number;
      onError?: (error: GithubExecutorError) => void;
      waitForLogRetry?: (ms: number, signal?: AbortSignal) => Promise<void>;
      pollIntervalMs?: number;
      queueWaitMs?: number;
      /** C-592: the executor's configured job shape; absent keeps Cardigan's. */
      stepContract?: GithubStepContract | undefined;
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
    binding?: RetryBinding,
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
      revision: 0,
      binding,
      retry: binding?.current,
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
  private sendCancel(state: Pending, parent?: AbortSignal): Promise<void> {
    if (state.cancelled || state.terminal || state.retry)
      return Promise.resolve();
    if (state.cancelWork) return state.cancelWork;
    state.cancelWork = githubDeadline(async (signal) => {
      await this.options.client.cancel(state.external.run_id, signal);
      signal.throwIfAborted();
      state.cancelled = true;
    }, parent).finally(() => {
      state.cancelWork = undefined;
    });
    return state.cancelWork;
  }
  async fetchFailureLog(
    run: ExternalGithubRun,
    open: OpenFailureLog,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = this.state(run);
    if (state.terminal) this.pending.delete(run.run_id);
    if (!state.failedJob) {
      // Cancellations have no failed job and never require diagnostics.
      if (state.identity.conclusion === "cancelled") return;
      // C-661: a successful job rejected by the step contract has no job log
      // to download; the host's own diagnostic is the failure log.
      if (state.rejection) {
        open()(`${state.rejection}\n`);
        return;
      }
      throw new FailureLogError("job_unavailable");
    }
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        await this.options.client.jobLog(
          state.failedJob,
          () => open(state.logSteps ?? []),
          signal,
        );
        return;
      } catch (error) {
        signal?.throwIfAborted();
        if (error instanceof GithubRetryLater)
          throw new FailureLogError("rate_limited");
        if (
          error instanceof GithubExecutorError &&
          (error.category === "auth" || error.category === "security")
        )
          throw new FailureLogError(error.category);
        // A download that ran into its total cap would only repeat that wait.
        if (
          attempt === 2 ||
          (error instanceof GithubLogError && error.limit === "total")
        )
          // C-529: other provider diagnostics never leave this boundary; only
          // the job log client's scrubbed, fixed-shape detail is recorded.
          throw error instanceof GithubLogError
            ? new FailureLogError(error.failure, error.diagnostic)
            : new FailureLogError(
                error instanceof GithubNotFoundError ? "not_found" : "api",
              );
        const ms = 1000 * 2 ** attempt;
        if (this.options.waitForLogRetry)
          await this.options.waitForLogRetry(ms, signal);
        else await delay(ms, undefined, { signal });
      }
    }
  }

  tick(): Promise<void> {
    // Local start deadlines keep advancing while REST is in Retry-After/budget backoff.
    for (const state of this.pending.values()) {
      if (
        !state.terminal &&
        !state.retry &&
        state.identity.status &&
        state.identity.status !== "completed"
      )
        this.waiting(state, state.identity);
    }
    if (this.listing)
      return this.listing.then(
        ({ done }) => done,
        () => {},
      );
    if (this.now() < this.next) return Promise.resolve();
    this.next =
      this.now() +
      (this.options.pollIntervalMs ?? GITHUB_POLL_DEFAULTS.pollIntervalMs);
    const active = [...this.pending.values()].filter(
      (state) =>
        !state.terminal && (!state.retry || this.now() >= state.retry.retryAt),
    );
    if (!active.length) return Promise.resolve();
    // A cancel acknowledgement is not terminal evidence. Join its bounded IO
    // for shutdown, but never make it a prerequisite for this or the next list.
    return githubDeadline(async (signal) => {
      const cancellations = active
        .filter((state) => state.cancelRequested)
        .map((state) =>
          this.sendCancel(state, signal).catch((error: unknown) => {
            if (!signal.aborted) this.deferred(error);
          }),
        );
      const listing = githubDeadline(
        () => this.cycle(active, signal),
        signal,
      ).finally(() => {
        if (this.listing === listing) this.listing = undefined;
      });
      this.listing = listing;
      await Promise.all([listing.then(({ done }) => done), ...cancellations]);
    }).catch((error: unknown) => {
      // A previous generation's timeout is diagnostic only; a newer list
      // may already have installed its ETag while the old jobs were pending.
      this.report(error);
    });
  }
  private report(error: unknown): void {
    const category =
      error instanceof GithubExecutorError ? error.category : "api";
    try {
      this.options.onError?.(
        error instanceof DOMException && error.name === "TimeoutError"
          ? Object.assign(new GithubExecutorError(category), {
              message: "GitHub poll cycle timed out",
              diagnostic: "GitHub poll cycle timed out",
            })
          : new GithubExecutorError(category),
      );
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
  private async cycle(active: Pending[], signal: AbortSignal) {
    const requestedEtag = this.etag;
    let response: Awaited<ReturnType<GithubClient["pollRuns"]>>;
    try {
      response = await this.options.client.pollRuns(requestedEtag, signal);
      signal.throwIfAborted();
    } catch (error) {
      if (!signal.aborted) this.deferred(error);
      return { done: Promise.resolve() };
    }
    if (!response.unchanged) this.etag = response.etag;
    // Serialize details per run, not per executor. The next list can deliver
    // new evidence for peers while this run is still reading jobs.
    return {
      done: Promise.all(
        active.map((state) =>
          this.read(state, response, requestedEtag, signal),
        ),
      ).then(() => {}),
    };
  }
  private async read(
    state: Pending,
    response: Awaited<ReturnType<GithubClient["pollRuns"]>>,
    requestedEtag: string | undefined,
    signal: AbortSignal,
  ) {
    if (state.terminal) return;
    try {
      let run: GithubRun | undefined;
      if (response.unchanged) {
        // A 304 validates only the representation requested. This run may
        // have skipped that list during its own backoff.
        if (state.listed && state.listed.etag === requestedEtag)
          run = state.listed.run;
      } else {
        const listed = response.runs.filter(
          (r) => r?.id === state.external.run_id,
        );
        run = listed[0];
        delete state.listed;
        if (
          listed.length > 1 ||
          (run && !sameIdentity(state.identity, run, state.boundByDispatchId))
        ) {
          state.revision++; // A late detail read cannot release conflicting evidence.
          throw new GithubExecutorError("security");
        }
        if (run && response.etag) state.listed = { etag: response.etag, run };
      }
      if (state.reading) {
        if (
          run &&
          (run.status !== state.identity.status ||
            run.conclusion !== state.identity.conclusion)
        ) {
          state.revision++;
          this.observe(state, run);
        }
        return; // This run's earlier tick owns the in-flight request.
      }
      state.reading = githubDeadline(
        (deadline) => this.process(state, run, state.revision, deadline),
        signal,
      ).finally(() => {
        state.reading = undefined;
      });
      await state.reading;
    } catch (error) {
      if (signal.aborted || this.deferred(error)) return;
      if (
        error instanceof GithubExecutorError &&
        error.category === "security"
      ) {
        const retry = nextMaintenanceRetry(
          state.retry,
          this.now(),
          this.options.pollIntervalMs ?? GITHUB_POLL_DEFAULTS.pollIntervalMs,
          "identity_mismatch",
        );
        state.retry = retry;
        this.unconfirmed(state);
        state.binding?.save(retry);
      }
    }
  }
  private observe(state: Pending, run: GithubRun) {
    if (run.status !== "completed") {
      this.waiting(state, run);
      return;
    }
    // End the queue deadline on a bound completion, not after jobs returns.
    state.identity = run;
    state.started = true;
    state.request.onExecutionStarted?.();
    this.progress(state, "GitHub 检查已结束");
  }
  private async process(
    state: Pending,
    listed: GithubRun | undefined,
    revision: number,
    signal: AbortSignal,
  ) {
    const run =
      listed ?? (await this.options.client.run(state.external.run_id, signal));
    if (signal.aborted || state.revision !== revision) return;
    if (!sameIdentity(state.identity, run, state.boundByDispatchId))
      throw new GithubExecutorError("security");
    if (state.retry) {
      state.binding?.save(undefined);
      state.retry = undefined;
    }
    this.observe(state, run);
    if (run.status !== "completed") return;
    if (run.conclusion === "cancelled") {
      state.onTerminal?.();
      this.close(state, {
        status: "interrupted",
        checks: [],
        cleanup_errors: [],
      });
      return;
    }
    const jobs = await this.options.client.jobs(run.id, signal);
    if (signal.aborted || state.revision !== revision) return;
    const result = mapGithubCheckResult(
      state.request,
      run,
      jobs,
      this.options.stepContract,
    );
    state.failedJob = result.logSource?.jobId;
    if (state.failedJob && result.checks.length && jobs[0])
      state.logSteps = jobs[0].steps;
    state.rejection = result.reason?.startsWith(GITHUB_CONTRACT_REJECTED)
      ? result.reason
      : undefined;
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
        logSource: { url: state.external.html_url },
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
    state.resolve({
      ...unavailable(),
      logSource: { url: state.external.html_url },
    });
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
  contract?: GithubStepContract,
): CheckoutResult {
  if (run.conclusion === "cancelled")
    return { status: "interrupted", checks: [], cleanup_errors: [] };
  // Both callers verified this run before requesting jobs. Only the bound
  // completed job can supply a locator or be used to download diagnostics.
  const job = jobs.length === 1 ? jobs[0] : undefined;
  if (
    !job ||
    job.name !== "check" ||
    job.status !== "completed" ||
    job.run_id !== run.id ||
    job.run_attempt !== 1 ||
    job.head_sha !== run.head_sha ||
    !Number.isSafeInteger(job.id) ||
    job.id < 1
  )
    return {
      ...rejected(
        `须为唯一、已结束、属于本次运行且名为 check 的 job（实际 ${jobs.length} 个 job${job ? `，名为 ${shown(job.name)}，状态 ${shown(job.status)}` : ""}）`,
      ),
      logSource: { url: run.html_url },
    };
  const result = mapGithubCheckSteps(request, run, job, contract);
  return result.status === "passed"
    ? result
    : {
        ...result,
        logSource: {
          url: run.html_url,
          ...(job.conclusion !== "success" ? { jobId: job.id } : {}),
        },
      };
}
function mapGithubCheckSteps(
  request: CheckRequest,
  run: GithubRun,
  job: GithubJob,
  configured?: GithubStepContract,
): CheckoutResult {
  if (!Array.isArray(job.steps)) return rejected("job 没有步骤列表");

  const steps = [...job.steps];
  if (steps[0]?.name === GITHUB_SETUP_STEP) steps.shift();
  if (steps.at(-1)?.name === GITHUB_COMPLETE_STEP) steps.pop();
  // Without a configured contract, accept exactly the complete old Cardigan
  // contract or the complete case contract. Never treat arbitrary
  // missing/extra business steps as optional. Receipts and isolated case
  // retries belong to Cardigan's workflow only.
  const receipts = configured
    ? []
    : checkFlakeIds.map((id) => `Recovered ${id}`);
  const caseContract =
    !configured && steps.some((step) => step?.name === CASE_SCOPE_STEP);
  // C-661: a configured contract may differ per baseline. The run's
  // head_branch is the baseline the workflow was dispatched on; both callers
  // verified it against the bound identity before reading jobs.
  const contract: GithubStepShape = configured
    ? githubStepShape(configured, run.head_branch)
    : caseContract
      ? CARDIGAN_CASE_CONTRACT
      : CARDIGAN_CONTRACT;
  const contractName = configured
    ? configured.branches?.has(run.head_branch)
      ? `基线 ${shown(run.head_branch)} 的步骤合同`
      : `执行器默认步骤合同（基线 ${shown(run.head_branch)}）`
    : "Cardigan 默认步骤合同";
  const setup = job.steps[0]?.name === GITHUB_SETUP_STEP ? 1 : 0;
  if (steps.some((step) => !step)) return rejected("job 步骤列表含空项");
  const comparison = compareGithubStepContract(
    steps.map((step) => step.name),
    contract,
  );
  if (!comparison.ok)
    return rejected(
      [
        `${contractName}第 ${comparison.index + 1 + setup} 步期望 ${shown(comparison.expected)}，实际 ${shown(comparison.actual)}`,
        `期望步骤：${[
          `${GITHUB_SETUP_STEP}（可缺省）`,
          ...contract.steps.map((matcher) =>
            shown(describeGithubStepMatcher(matcher)),
          ),
        ].join("、")}`,
        `期望收尾（按序，均可缺省）：${[
          ...contract.postSteps.map((matcher) =>
            "name" in matcher
              ? shown(matcher.name)
              : `Post Run ${shown(matcher.uses)}@<ref>`,
          ),
          GITHUB_COMPLETE_STEP,
        ].join("、")}`,
        `实际步骤：${job.steps.map((step) => shown(step.name)).join("、")}`,
      ].join("\n"),
    );
  const mainStepCount = comparison.mainSteps + setup;
  const bad = job.steps.findIndex(
    (step, index) =>
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
  );
  const badStep = job.steps[bad];
  if (badStep)
    return rejected(
      `第 ${bad + 1} 步 ${shown(badStep.name)} 的编号不连续，或未结束、结论未知`,
    );
  if (
    request.checks.length !== GITHUB_CHECK_NAMES.length ||
    request.checks.some(
      (step, index) => step.name !== GITHUB_CHECK_NAMES[index],
    )
  )
    return rejected(`请求的检查须依次为 ${GITHUB_CHECK_NAMES.join("/")}`);
  const scope = githubCheckScope(request);
  const intentionalSkip = (name: string) =>
    receipts.includes(name) ||
    (scope.scope === "docs_only" &&
      scope.skip_checks.split(",").includes(name)) ||
    (request.mergeTier === "card" && name === "e2e");
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
          ? {
              name,
              status: "skipped",
              reason:
                request.mergeTier === "card" && name === "e2e"
                  ? "card_tier"
                  : "docs_only",
              exit_code: null,
            }
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
  const recovered = checkFlakeIds.filter(
    (id) =>
      !configured &&
      steps.some(
        (step) =>
          step.name === `Recovered ${id}` && step.conclusion === "success",
      ),
  );
  const isolated = caseContract
    ? steps.find((s) => s.name === CASE_RUN_STEP)
    : undefined;
  if (
    recovered.length &&
    (!["success", "failure"].includes(isolated?.conclusion ?? "") ||
      request.mergeTier === "batch" ||
      scope.skip_checks.split(",").includes("test") ||
      (scope.scope === "affected" &&
        recovered.some(
          (id) =>
            !scope.affected_paths
              .split(" ")
              .some((pkg) => checkFlakeCases[id].file.startsWith(`${pkg}/`)),
        )))
  )
    return rejected("Recovered 回执与本次检查范围不符");
  const failedGithubStep = job.steps.find(
    (s) =>
      !checks.some((c) => c.name === s.name) &&
      (s.conclusion === "failure" || s.conclusion === "timed_out"),
  )?.name;
  return {
    // The new workflow already made the case-level retry decision. Do not
    // turn a remaining Vitest timeout into a second, whole-check retry.
    ...(caseContract &&
    request.mergeTier !== "batch" &&
    (isolated?.conclusion === "failure" ||
      checks.some((step) => step.name === "test" && step.status === "failed"))
      ? { caseTimeoutsManaged: true }
      : {}),
    ...(recovered.length ? { recovered } : {}),
    ...(failedGithubStep ? { failedGithubStep } : {}),
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
  stepContract?: GithubStepContract | undefined;
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
  return mapGithubCheckResult(
    request,
    run,
    await client.jobs(runId),
    options.stepContract,
  );
}
