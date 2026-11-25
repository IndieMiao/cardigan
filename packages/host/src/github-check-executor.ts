import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  CandidatePushFailure,
  CandidatePushRequest,
  CandidatePushResult,
} from "@cardigan/git-transport";
import type {
  CheckExecutor,
  CheckHandle,
  CheckRequest,
  OpenFailureLog,
} from "./check-executor.js";
import {
  CandidateRepositoryBusy,
  CheckExecutorSuspended,
  checkoutSupervisionMs,
} from "./checkout-deadline.js";
import {
  type DispatchUnknownStage,
  GithubHttpTrace,
  githubHttpTrace,
  pushFailureStage,
  validObservation,
} from "./executor-diagnostics.js";
import { githubScopedRequest } from "./github-check-scope.js";
import {
  type GithubClient,
  GithubExecutorError,
  GithubNotFoundError,
  type GithubRun,
  sameGithubRun,
} from "./github-client.js";
import { githubDeadline } from "./github-deadline.js";
import {
  discoverUnboundGithub,
  type GithubCheckContext,
  githubCheckRunName,
  githubDispatchIdentity,
} from "./github-dispatch-discovery.js";
import type {
  ExternalGithubRun,
  GithubDispatchIntent,
  GithubDispatchJournal,
  RetryBinding,
} from "./github-dispatch-journal.js";
import {
  GITHUB_POLL_DEFAULTS,
  GithubRetryLater,
  nextMaintenanceRetry,
} from "./github-rate-limit.js";
import type { GithubMergeGateExecutor } from "./merge-gate-executors.js";
import { boundedCheckSummary, safeCheckDiagnostic } from "./merge-gate-log.js";
import { validPushBranch } from "./merge-push-config.js";
import type { CheckoutResult } from "./temporary-checkout.js";

export {
  type GithubCheckContext,
  githubCheckRunName,
} from "./github-dispatch-discovery.js";
/** C-758: pauses before each retry of a transient candidate push (20 s total). */
export const CANDIDATE_PUSH_RETRY_DELAYS_MS: readonly number[] = [
  5_000, 15_000,
];
const RETRIED_PUSH_FAILURES: ReadonlySet<CandidatePushFailure> = new Set([
  "auth",
  "network",
  "github_error",
  "other",
]);
async function abortableDelay(ms: number, signal?: AbortSignal) {
  try {
    await sleep(ms, undefined, signal ? { signal } : undefined);
  } catch {
    // An abort ends the wait; the caller re-checks the signal.
  }
}
/** D4 owns shared polling, cancellation, log redaction and terminal confirmation. */
export interface GithubCheckLifecycle {
  /** Only the terminal callback releases the reservation; local failures keep tracking it. */
  register?(
    run: ExternalGithubRun,
    request: CheckRequest,
    identity: GithubRun,
    onTerminal?: () => void,
    boundByDispatchId?: boolean,
    retry?: RetryBinding,
  ): void;
  poll(run: ExternalGithubRun): Promise<CheckoutResult>;
  cancel(run: ExternalGithubRun): Promise<void>;
  fetchFailureLog(
    run: ExternalGithubRun,
    open: OpenFailureLog,
    signal?: AbortSignal,
  ): Promise<void>;
}
/** Trusted dispatch adapter; handles share the configured executor lifecycle. */
export class GithubCheckExecutor implements CheckExecutor {
  get startupTimeoutMs(): number {
    return this.options.config.queueWaitMs ?? GITHUB_POLL_DEFAULTS.queueWaitMs;
  }
  private readonly handles = new WeakMap<
    CheckHandle,
    { run: ExternalGithubRun; intent: GithubDispatchIntent }
  >();
  private readonly pending = new Map<
    string,
    { key: string; work: Promise<CheckHandle | undefined> }
  >();
  constructor(
    private readonly options: {
      config: GithubMergeGateExecutor;
      client: Pick<GithubClient, "token" | "dispatch" | "run" | "runs">;
      journal: GithubDispatchJournal;
      context: (request: CheckRequest) => GithubCheckContext;
      /** Only the trusted Git adapter can prove that transport was never entered. */
      push: (
        request: CandidatePushRequest,
      ) => Promise<CandidatePushResult | { status: "not_started" }>;
      /** C-758: waits before the bounded in-fence retries of a transient push failure. */
      pushRetryDelaysMs?: readonly number[];
      /** Must check the central repository's exact configured baseline ref. */
      isBaselineAncestor: (sha: string, branch: string) => Promise<boolean>;
      lifecycle: GithubCheckLifecycle;
      now?: () => number;
    },
  ) {}
  async dispatch(request: CheckRequest): Promise<CheckHandle> {
    const handle = await this.request(request);
    if (!handle) throw new GithubExecutorError("security");
    return handle;
  }
  recoverAbandoned(
    request: CheckRequest,
    intent: GithubDispatchIntent,
  ): Promise<CheckHandle | undefined> {
    return githubDeadline(
      (signal) => this.request({ ...request, signal }, intent),
      request.signal,
    );
  }
  private request(
    request: CheckRequest,
    abandoned?: GithubDispatchIntent,
  ): Promise<CheckHandle | undefined> {
    try {
      request = githubScopedRequest(
        request,
        this.options.config.scopedChecks === true,
      );
      const context = this.options.context(request);
      const safe = (value: string | undefined): value is string =>
        typeof value === "string" && /^[A-Za-z0-9_-]+$/u.test(value);
      if (
        !safe(request.project) ||
        !safe(context.card) ||
        !safe(context.delivery) ||
        !safe(request.attempt) ||
        !/^[a-f0-9]{40}$/u.test(request.sha) ||
        !/^[a-f0-9]{40}$/u.test(request.tree) ||
        !validPushBranch(context.baselineBranch) ||
        context.baselineBranch.startsWith("ci/") ||
        request.signal?.aborted
      )
        throw new GithubExecutorError("security");
      // C-647: a restart may also change the local admission limit (for
      // example max_concurrent 1 -> 16). Resuming this attempt's own durable
      // intent proves its historical key; workflow, credentials and inputs
      // must still match exactly.
      const known =
        abandoned?.key ??
        this.options.journal
          .unfinished()
          .find(
            (intent) =>
              intent.project === request.project &&
              intent.card === context.card &&
              intent.attempt === request.attempt &&
              intent.executor === this.options.config.name,
          )?.key;
      const { inputs, key } = githubDispatchIdentity(
        request,
        context,
        this.options.config,
        known,
      );
      if (
        abandoned &&
        (abandoned.key !== key ||
          abandoned.project !== request.project ||
          abandoned.card !== context.card ||
          abandoned.attempt !== request.attempt)
      )
        throw new GithubExecutorError("security");
      const id = `${request.project}/${request.attempt}`;
      const existing = this.pending.get(id);
      if (existing) {
        if (existing.key !== key) throw new GithubExecutorError("security");
        return existing.work;
      }
      const trace = new GithubHttpTrace();
      const work = githubHttpTrace.run(trace, () =>
        this.start(request, context, inputs, key, trace, abandoned),
      );
      this.pending.set(id, { key, work });
      void work.catch(() => {
        if (this.pending.get(id)?.work === work) this.pending.delete(id);
      });
      return work;
    } catch (error) {
      return Promise.reject(
        error instanceof GithubExecutorError
          ? error
          : new GithubExecutorError("security"),
      );
    }
  }
  private async start(
    request: CheckRequest,
    context: GithubCheckContext,
    inputs: Record<string, string>,
    key: string,
    trace: GithubHttpTrace,
    abandoned?: GithubDispatchIntent,
  ): Promise<CheckHandle | undefined> {
    let claimedIntent: GithubDispatchIntent | undefined;
    let dispatchToken = "";
    // C-681: every dispatch_unknown names its branch and the latest redacted
    // GitHub exchange of this call, plus the persisted POST response if any.
    const dispatchUnknown = (
      stage: DispatchUnknownStage,
      pushFailure?: CandidatePushFailure,
    ) => {
      const error = new GithubExecutorError("dispatch_unknown");
      const persisted = claimedIntent?.dispatchResponse;
      const post =
        trace.dispatch ?? (validObservation(persisted) ? persisted : undefined);
      error.dispatch = {
        stage,
        ...(pushFailure ? { pushFailure } : {}),
        ...(trace.last ? { last: trace.last } : {}),
        ...(post ? { post } : {}),
      };
      return error;
    };
    try {
      const registeredAt = this.options.now?.() ?? Date.now();
      const startedAt = new Date(
        Math.floor(registeredAt / 1000) * 1000,
      ).toISOString();
      const publicationDeadlineAt =
        request.kind === "merge_check"
          ? registeredAt +
            checkoutSupervisionMs(request.totalTimeoutMs, this.startupTimeoutMs)
          : undefined;
      const claimed = abandoned
        ? { intent: this.options.journal.recoverAbandoned(abandoned) }
        : this.options.journal.claim(
            {
              project: request.project,
              card: context.card,
              attempt: inputs.attempt as string,
              key,
              startedAt,
              discoveryDeadlineAt:
                Date.parse(startedAt) +
                Math.min(
                  this.options.config.waitStartMs ??
                    GITHUB_POLL_DEFAULTS.waitStartMs,
                  request.totalTimeoutMs ?? 60 * 60_000,
                ),
              phase: "reserved",
              executor: this.options.config.name,
              candidate: {
                repo: this.options.config.repo,
                ref: `refs/heads/ci/${context.card}/${context.delivery}/${inputs.attempt}`,
                sha: request.sha,
                delivery: context.delivery,
              },
            },
            this.options.config.maxConcurrent,
          );
      const intent = claimed.intent;
      claimedIntent = intent;
      if (
        intent.maintenanceRetry &&
        (this.options.now?.() ?? Date.now()) < intent.maintenanceRetry.retryAt
      )
        throw new GithubRetryLater(intent.maintenanceRetry.retryAt, "attempt");
      let boundByDispatchId = intent.boundByDispatchId === true;
      let run: GithubRun;
      if (intent.externalRun) {
        run = await this.options.client.run(intent.externalRun.run_id);
        if (intent.identity && run.created_at !== intent.identity.created_at)
          throw new GithubExecutorError("security");
      } else {
        if (intent.phase === "publishing")
          throw new GithubExecutorError("recovery_incomplete");
        let runId = intent.dispatchedRunId;
        if (intent.phase === "reserved") {
          if (request.signal?.aborted) throw dispatchUnknown("not_sent");
          const token = await this.options.client.token();
          dispatchToken = token;
          // Claim the IO boundary before push: abandonment/cleanup must not
          // race a late publisher or allow a second controller to publish.
          if (
            this.options.journal.beginPublication(intent, publicationDeadlineAt)
          ) {
            let outcome: "pushed" | "not_started" | "cancelled" = "cancelled";
            let failed: CandidatePushFailure | undefined;
            let dispatch: boolean;
            try {
              const candidate = {
                repo: this.options.config.repo,
                sha: request.sha,
                ref: `refs/heads/ci/${context.card}/${context.delivery}/${inputs.attempt}`,
                token,
                ...(request.signal ? { signal: request.signal } : {}),
              };
              let result = await this.options.push(candidate);
              // C-758: bounded retries inside the same publication fence for a
              // transient answer (e.g. a just-minted installation token that
              // GitHub's Git frontend does not accept yet). Timeouts, rejected
              // refs and local cancellation are never retried here.
              for (const delay of this.options.pushRetryDelaysMs ??
                CANDIDATE_PUSH_RETRY_DELAYS_MS) {
                if (
                  result.status !== "failed" ||
                  !RETRIED_PUSH_FAILURES.has(result.reason) ||
                  request.signal?.aborted
                )
                  break;
                await abortableDelay(delay, request.signal);
                if (request.signal?.aborted) break;
                const retried = await this.options.push(candidate);
                // An earlier attempt entered transport: a busy lock on a retry
                // is not proof that nothing was ever sent. Keep that failure.
                if (retried.status === "not_started") break;
                result = retried;
              }
              if (result.status === "not_started") {
                outcome = "not_started";
                throw new CandidateRepositoryBusy();
              }
              if (result.status === "failed") failed = result.reason;
              if (result.status === "pushed" && !request.signal?.aborted) {
                if (request.kind === "merge_check")
                  await request.beforeDispatch?.();
                if (!request.signal?.aborted) outcome = "pushed";
              }
            } finally {
              // Settle every push outcome before releasing its writer fence.
              // Only a successful, still-current publication may cross POST.
              dispatch = this.options.journal.beginDispatch(intent, outcome);
            }
            // C-758: name the real cause. A local abort, or a pushed candidate
            // whose fence was taken by abandonment, is a local cancellation.
            if (!dispatch)
              throw request.signal?.aborted || failed === undefined
                ? dispatchUnknown("push_cancelled")
                : dispatchUnknown(pushFailureStage(failed), failed);
            try {
              runId = await this.options.client.dispatch(
                context.baselineBranch,
                inputs,
              );
            } finally {
              this.options.journal.settleDispatch(
                intent,
                runId,
                this.options.now?.() ?? Date.now(),
                trace.dispatch,
              );
            }
          } else throw new GithubExecutorError("recovery_incomplete");
        }
        const now = this.options.now?.() ?? Date.now();
        const interval =
          this.options.config.pollIntervalMs ??
          GITHUB_POLL_DEFAULTS.pollIntervalMs;
        const deferDiscovery = (): never => {
          if (
            !request.signal?.aborted &&
            (this.options.now?.() ?? Date.now()) <
              (intent.discoveryDeadlineAt ??
                Date.parse(intent.startedAt) +
                  Math.min(
                    this.options.config.waitStartMs ??
                      GITHUB_POLL_DEFAULTS.waitStartMs,
                    request.totalTimeoutMs ?? 60 * 60_000,
                  ))
          )
            throw new GithubRetryLater(now + interval, "attempt");
          throw dispatchUnknown("run_not_found");
        };
        if (runId !== undefined) {
          this.options.journal.beginDiscovery(intent, now, interval, runId);
          try {
            // Already-dispatched live attempts need a late cancellation handle.
            // Only read-only abandoned maintenance can abandon this exact read.
            run = abandoned
              ? await this.options.client.run(runId, request.signal)
              : await this.options.client.run(runId);
          } catch (error) {
            // The dispatch response can precede REST visibility of its run.
            if (error instanceof GithubNotFoundError) deferDiscovery();
            throw error;
          }
          if (run.id !== runId) throw new GithubExecutorError("security");
          boundByDispatchId = true;
        } else {
          const matches = await discoverUnboundGithub({
            client: this.options.client,
            journal: this.options.journal,
            intent,
            key,
            inputs,
            branch: context.baselineBranch,
            config: this.options.config,
            clock: this.options.now ?? Date.now,
            signal: request.signal,
            finishAs: abandoned ? "automatic" : undefined,
          });
          if (!matches) return undefined; // Verified absent; there is no remote handle.
          const match = matches[0];
          if (!matches.length) deferDiscovery();
          if (matches.length !== 1 || !match)
            throw matches.length
              ? new GithubExecutorError("security")
              : dispatchUnknown("run_not_found");
          if (request.signal?.aborted)
            throw new GithubExecutorError("recovery_incomplete");
          // A list is discovery evidence. Re-read the exact ID before binding;
          // reruns or identity drift during a long scan invalidate that evidence.
          run = await this.options.client.run(match.id, request.signal);
          if (!sameGithubRun(match, run))
            throw new GithubExecutorError("security");
        }
      }
      const external = await this.bind(
        run,
        context,
        inputs,
        intent,
        boundByDispatchId,
      );
      // Keep the host's dispatch inputs for recovery routing. The provider's
      // mutable display title is not identity evidence for a dispatch response ID.
      const identity = { ...run, display_title: githubCheckRunName(inputs) };
      if (abandoned) request.signal?.throwIfAborted();
      const current = this.options.journal.bind(
        intent,
        external,
        identity,
        boundByDispatchId,
      );
      this.options.lifecycle.register?.(
        external,
        request,
        identity,
        () => this.options.journal.finish(intent),
        boundByDispatchId,
        this.options.journal.retryBinding({
          ...intent,
          externalRun: external,
          maintenanceRetry: intent.externalRun
            ? intent.maintenanceRetry
            : undefined,
        }),
      );
      // A late dispatch still returns a cancellable handle, without publishing
      // readiness or domain callbacks after the supervisor has closed.
      if (!current) await this.options.lifecycle.cancel(external);
      if (current && !request.signal?.aborted) {
        context.onExternalRun?.(external);
        request.onReady?.();
      }
      const handle = { id: randomUUID() };
      this.handles.set(handle, { run: external, intent });
      return handle;
    } catch (error) {
      // Only a matching durable claim can record a failed identity check.
      // Abandoned discovery records its own deadline and backoff at the caller.
      if (
        claimedIntent &&
        !abandoned &&
        !request.signal?.aborted &&
        error instanceof GithubExecutorError &&
        error.category === "security"
      ) {
        this.options.journal
          .retryBinding(claimedIntent)
          .save(
            nextMaintenanceRetry(
              claimedIntent.maintenanceRetry,
              this.options.now?.() ?? Date.now(),
              this.options.config.pollIntervalMs ??
                GITHUB_POLL_DEFAULTS.pollIntervalMs,
              "identity_mismatch",
            ),
          );
      }
      // Uncertain dispatches retain their durable card reservation. A restart
      // searches by exact identity; it never POSTs a second workflow run.
      if (
        error instanceof CheckExecutorSuspended ||
        error instanceof GithubExecutorError ||
        (error instanceof GithubRetryLater &&
          (claimedIntent?.externalRun ||
            this.options.journal.hasUnboundIntent(
              request.project,
              context.card,
              inputs.attempt as string,
            )))
      )
        throw error;
      const wrapped = new GithubExecutorError("api");
      const type =
        error instanceof TypeError
          ? "TypeError"
          : error instanceof RangeError
            ? "RangeError"
            : error instanceof Error
              ? "Error"
              : typeof error;
      wrapped.diagnostic = boundedCheckSummary(
        `${type}: ${safeCheckDiagnostic(error, { ...request.env, githubToken: dispatchToken }).replace(/\b(?:ghs_|ghp_|github_pat_)[A-Za-z0-9_.-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|authorization\s*:\s*[^\r\n]*|PRIVATE-KEY|JWT/giu, "[REDACTED]")}`,
      );
      throw wrapped;
    }
  }
  private async bind(
    run: GithubRun,
    context: GithubCheckContext,
    inputs: Record<string, string>,
    intent: GithubDispatchIntent,
    boundByDispatchId: boolean,
  ): Promise<ExternalGithubRun> {
    if (!boundByDispatchId && run.display_title !== githubCheckRunName(inputs))
      throw new GithubExecutorError("security");
    await this.validateRun(run, context, intent);
    return {
      provider: "github",
      run_id: run.id,
      run_attempt: 1,
      html_url: run.html_url,
      workflow_sha: run.head_sha,
    };
  }
  private async validateRun(
    run: GithubRun,
    context: GithubCheckContext,
    intent: GithubDispatchIntent,
  ): Promise<void> {
    const { config } = this.options;
    const now = this.options.now?.() ?? Date.now();
    if (
      !Number.isSafeInteger(run.id) ||
      run.id < 1 ||
      (run.path !== config.workflow &&
        run.path !== `${config.workflow}@${context.baselineBranch}`) ||
      run.event !== "workflow_dispatch" ||
      run.head_branch !== context.baselineBranch ||
      !/^[a-f0-9]{40}$/u.test(run.head_sha) ||
      run.actor?.login !== config.botLogin ||
      (run.triggering_actor !== undefined &&
        run.triggering_actor.login !== config.botLogin) ||
      run.run_attempt !== 1 ||
      run.html_url !==
        `https://github.com/${config.repo}/actions/runs/${run.id}` ||
      !Number.isFinite(Date.parse(run.created_at)) ||
      Date.parse(run.created_at) < Date.parse(intent.startedAt) ||
      Date.parse(run.created_at) > now ||
      !(await this.options.isBaselineAncestor(
        run.head_sha,
        context.baselineBranch,
      ))
    )
      throw new GithubExecutorError("security");
  }
  private run(handle: CheckHandle): ExternalGithubRun {
    const run = this.handles.get(handle);
    if (!run) throw new GithubExecutorError("security");
    return run.run;
  }
  async poll(handle: CheckHandle) {
    try {
      const result = await this.options.lifecycle.poll(this.run(handle));
      const state = this.handles.get(handle);
      if (
        state &&
        !this.options.lifecycle.register &&
        result.status !== "executor_unreachable"
      )
        this.options.journal.finish(state.intent);
      return result;
    } catch {
      throw new GithubExecutorError("api");
    }
  }
  async cancel(handle: CheckHandle) {
    try {
      await this.options.lifecycle.cancel(this.run(handle));
    } catch {
      throw new GithubExecutorError("api");
    }
  }
  async fetchFailureLog(
    handle: CheckHandle,
    open: OpenFailureLog,
    signal?: AbortSignal,
  ) {
    await this.options.lifecycle.fetchFailureLog(
      this.run(handle),
      open,
      signal,
    );
  }
}
