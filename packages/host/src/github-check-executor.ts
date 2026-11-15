import { createHash, randomUUID } from "node:crypto";
import type { CandidatePushRequest, PushResult } from "@cardigan/git-transport";
import type {
  CheckExecutor,
  CheckHandle,
  CheckRequest,
} from "./check-executor.js";
import {
  type GithubClient,
  GithubExecutorError,
  type GithubRun,
  sameGithubRun,
} from "./github-client.js";
import type {
  ExternalGithubRun,
  GithubDispatchIntent,
  GithubDispatchJournal,
} from "./github-dispatch-journal.js";
import { GithubRetryLater } from "./github-rate-limit.js";
import type { GithubMergeGateExecutor } from "./merge-gate-executors.js";
import { validPushBranch } from "./merge-push-config.js";
import type { CheckoutResult } from "./temporary-checkout.js";

/** D2 uses this exact six-input expression for workflow run-name. */
export function githubCheckRunName(
  inputs: Readonly<Record<string, string>>,
): string {
  return `cardigan/${inputs.card}/${inputs.delivery}/${inputs.attempt}/${inputs.kind}/${inputs.sha}/${inputs.tree}`;
}
export interface GithubCheckContext {
  readonly card: string;
  readonly delivery: string;
  readonly baselineBranch: string;
  /** Called with validated public identity, before onReady. May persist a domain running record. */
  readonly onExternalRun?: (run: ExternalGithubRun) => void;
}
/** D4 owns shared polling, cancellation, log redaction and terminal confirmation. */
export interface GithubCheckLifecycle {
  /** Resolve only after a verified remote terminal state, or return executor_unreachable without releasing the reservation. */
  register?(
    run: ExternalGithubRun,
    request: CheckRequest,
    identity: GithubRun,
    onTerminal?: () => void,
  ): void;
  poll(run: ExternalGithubRun): Promise<CheckoutResult>;
  cancel(run: ExternalGithubRun): Promise<void>;
  fetchFailureLog(run: ExternalGithubRun): Promise<string | undefined>;
}
/** Trusted dispatch adapter; handles share the configured executor lifecycle. */
export class GithubCheckExecutor implements CheckExecutor {
  private readonly handles = new WeakMap<
    CheckHandle,
    { run: ExternalGithubRun; intent: GithubDispatchIntent }
  >();
  private readonly pending = new Map<
    string,
    { key: string; work: Promise<CheckHandle> }
  >();
  constructor(
    private readonly options: {
      config: GithubMergeGateExecutor;
      client: Pick<GithubClient, "token" | "dispatch" | "run" | "runs">;
      journal: GithubDispatchJournal;
      context: (request: CheckRequest) => GithubCheckContext;
      push: (request: CandidatePushRequest) => Promise<PushResult>;
      /** Must check the central repository's exact configured baseline ref. */
      isBaselineAncestor: (sha: string, branch: string) => Promise<boolean>;
      lifecycle: GithubCheckLifecycle;
      now?: () => number;
    },
  ) {}
  dispatch(request: CheckRequest): Promise<CheckHandle> {
    try {
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
      const inputs = {
        sha: request.sha,
        tree: request.tree,
        card: context.card,
        delivery: context.delivery,
        attempt: request.attempt,
        kind: request.kind,
      };
      // Cleanup policy is not dispatch identity; preserve existing durable keys.
      const dispatchConfig = { ...this.options.config };
      delete dispatchConfig.branchRetentionMs;
      const key = createHash("sha256")
        .update(
          JSON.stringify([
            dispatchConfig,
            request.project,
            context.baselineBranch,
            inputs,
          ]),
        )
        .digest("hex");
      const id = `${request.project}/${request.attempt}`;
      const existing = this.pending.get(id);
      if (existing) {
        if (existing.key !== key) throw new GithubExecutorError("security");
        return existing.work;
      }
      const work = this.start(request, context, inputs, key);
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
  ): Promise<CheckHandle> {
    let recoveringBound = false;
    try {
      const startedAt = new Date(
        Math.floor((this.options.now?.() ?? Date.now()) / 1000) * 1000,
      ).toISOString();
      const claimed = this.options.journal.claim(
        {
          project: request.project,
          card: context.card,
          attempt: inputs.attempt as string,
          key,
          startedAt,
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
      recoveringBound = intent.externalRun !== undefined;
      let run: GithubRun;
      if (intent.externalRun) {
        run = await this.options.client.run(intent.externalRun.run_id);
      } else {
        let runId: number | undefined;
        if (intent.phase === "reserved") {
          if (request.signal?.aborted)
            throw new GithubExecutorError("dispatch_unknown");
          const result = await this.options.push({
            repo: this.options.config.repo,
            sha: request.sha,
            ref: `refs/heads/ci/${context.card}/${context.delivery}/${inputs.attempt}`,
            token: await this.options.client.token(),
            ...(request.signal ? { signal: request.signal } : {}),
          });
          if (result.status !== "pushed" || request.signal?.aborted)
            throw new GithubExecutorError("dispatch_unknown");
          if (this.options.journal.beginDispatch(intent)) {
            runId = await this.options.client.dispatch(
              context.baselineBranch,
              inputs,
            );
          }
        }
        if (runId !== undefined) {
          run = await this.options.client.run(runId);
          if (run.id !== runId) throw new GithubExecutorError("security");
        } else {
          const listed = await this.options.client.runs(
            context.baselineBranch,
            intent.startedAt,
            request.signal,
          );
          const matches = listed.filter(
            (candidate) =>
              candidate.display_title === githubCheckRunName(inputs),
          );
          const match = matches[0];
          if (matches.length !== 1 || !match)
            throw new GithubExecutorError(
              matches.length ? "security" : "dispatch_unknown",
            );
          if (request.signal?.aborted)
            throw new GithubExecutorError("recovery_incomplete");
          // A list is discovery evidence. Re-read the exact ID before binding;
          // reruns or identity drift during a long scan invalidate that evidence.
          run = await this.options.client.run(match.id, request.signal);
          if (!sameGithubRun(match, run))
            throw new GithubExecutorError("security");
        }
      }
      const external = await this.bind(run, context, inputs, intent);
      this.options.journal.bind(intent, external, run);
      this.options.lifecycle.register?.(external, request, run, () =>
        this.options.journal.finish(intent),
      );
      // A late dispatch still returns a cancellable handle, without publishing
      // readiness or domain callbacks after the supervisor has closed.
      if (!request.signal?.aborted) {
        context.onExternalRun?.(external);
        request.onReady?.();
      }
      const handle = { id: randomUUID() };
      this.handles.set(handle, { run: external, intent });
      return handle;
    } catch (error) {
      // Uncertain dispatches retain their durable card reservation. A restart
      // searches by exact identity; it never POSTs a second workflow run.
      throw error instanceof GithubExecutorError ||
        (recoveringBound && error instanceof GithubRetryLater)
        ? error
        : new GithubExecutorError("api");
    }
  }
  private async bind(
    run: GithubRun,
    context: GithubCheckContext,
    inputs: Record<string, string>,
    intent: GithubDispatchIntent,
  ): Promise<ExternalGithubRun> {
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
      run.display_title !== githubCheckRunName(inputs) ||
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
    return {
      provider: "github",
      run_id: run.id,
      run_attempt: 1,
      html_url: run.html_url,
      workflow_sha: run.head_sha,
    };
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
      if (state && result.status !== "executor_unreachable")
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
  async fetchFailureLog(handle: CheckHandle) {
    try {
      return await this.options.lifecycle.fetchFailureLog(this.run(handle));
    } catch {
      throw new GithubExecutorError("api");
    }
  }
}
