import { createHash } from "node:crypto";
import type {
  CandidateDeleteRequest,
  CandidatePushRequest,
  PushResult,
} from "@cardigan/git-transport";
import type { Store } from "@cardigan/store";
import type { CheckHandle } from "./check-executor.js";
import { GithubBudgetJournal } from "./github-budget-journal.js";
import { GithubCheckExecutor } from "./github-check-executor.js";
import {
  GITHUB_CHECK_NAMES,
  GithubCheckPoller,
} from "./github-check-poller.js";
import { GithubClient, sameGithubRun } from "./github-client.js";
import { GithubDispatchJournal } from "./github-dispatch-journal.js";
import {
  type GithubBudgetStorage,
  GithubRateLimit,
  GithubRetryLater,
} from "./github-rate-limit.js";
import type { GithubMergeGateExecutor } from "./merge-gate-executors.js";
import type { ProbeAdapter, ProbeJob } from "./probe-service.js";
import type { CheckoutResult } from "./temporary-checkout.js";

/** One REST request consumes both the existing executor quota and the probe quota. */
class ProbeBudget extends GithubRateLimit {
  constructor(
    private readonly shared: GithubRateLimit,
    budget: number,
    storage: GithubBudgetStorage,
  ) {
    super(budget, Date.now, storage);
  }
  override reserve() {
    const refundShared = this.shared.reserve();
    try {
      const refundProbe = super.reserve();
      return () => {
        refundShared();
        refundProbe();
      };
    } catch (e) {
      refundShared();
      throw e;
    }
  }
  override backoff(header: string | null): never {
    return this.shared.backoff(header);
  }
}
export class GithubProbe implements ProbeAdapter {
  private readonly sessions = new Map<
    string,
    {
      executor: GithubCheckExecutor;
      poller: GithubCheckPoller;
      handle: CheckHandle;
      result?: CheckoutResult;
    }
  >();
  constructor(
    private readonly options: {
      store: Store;
      dataDir: string;
      config: (name: string) => GithubMergeGateExecutor | undefined;
      prepare: (
        job: ProbeJob,
      ) => Promise<{ sha: string; tree: string; baseline: string }>;
      push: (
        project: string,
        input: CandidatePushRequest,
      ) => Promise<PushResult>;
      remove: (
        project: string,
        input: CandidateDeleteRequest,
      ) => Promise<boolean>;
      isBaselineAncestor: (
        project: string,
        sha: string,
        branch: string,
      ) => Promise<boolean>;
      client?: (
        config: GithubMergeGateExecutor,
        rate: GithubRateLimit,
      ) => GithubClient;
    },
  ) {}
  async advance(
    job: ProbeJob,
    checkpoint: (job: ProbeJob) => void,
    cancelled = () => job.cancel_requested === true,
  ): Promise<ProbeJob> {
    if (cancelled()) job = { ...job, cancel_requested: true };
    const config = this.options.config(job.profile.executor ?? "");
    if (!config) return { ...job, cleanup: "held" };
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(config))
      .digest("hex");
    if (job.executor_fingerprint && job.executor_fingerprint !== fingerprint)
      return { ...job, cleanup: "held" };
    const journal = new GithubDispatchJournal(this.options.store, job.card_id);
    let intent = journal
      .all()
      .find((i) => i.project === job.project_id && i.attempt === job.id);
    if (job.cancel_requested && !intent)
      return { ...job, status: "cancelled", cleanup: "complete" };
    if (!job.tested_sha || !job.tree_sha || !job.baseline_branch) {
      try {
        const prepared = await this.options.prepare(job);
        job = {
          ...job,
          tested_sha: prepared.sha,
          tree_sha: prepared.tree,
          baseline_branch: prepared.baseline,
          executor_fingerprint: fingerprint,
        };
        checkpoint(job);
      } catch {
        return { ...job, status: "failed", cleanup: "complete" };
      }
    }
    if (cancelled()) {
      job = { ...job, cancel_requested: true };
      if (!intent) return { ...job, status: "cancelled", cleanup: "complete" };
    }
    const {
      tested_sha: testedSha,
      tree_sha: treeSha,
      baseline_branch: baseline,
    } = job;
    if (!testedSha || !treeSha || !baseline) return { ...job, cleanup: "held" };
    const delivery = `${job.project_id}-${job.card_id}-${job.assignment_id}`;
    const ref = `refs/heads/ci/probe/${delivery}/${job.id}`;
    const rate = new ProbeBudget(
      new GithubRateLimit(
        config.restBudgetPerHour,
        Date.now,
        new GithubBudgetJournal(this.options.store, config.name),
      ),
      job.profile.rest_budget_per_hour,
      new GithubBudgetJournal(this.options.store, `probe:${config.name}`),
    );
    const client =
      this.options.client?.(config, rate) ??
      new GithubClient({ config, dataDir: this.options.dataDir, rate });
    if (intent?.deleted)
      return {
        ...job,
        status: job.status === "passed" ? "passed" : "failed",
        cleanup: "complete",
      };
    if (
      job.cancel_requested &&
      intent?.phase === "reserved" &&
      !intent.externalRun
    ) {
      journal.finishUnpublishedProbe(intent);
      intent = journal
        .all()
        .find((i) => i.project === job.project_id && i.attempt === job.id);
      job = { ...job, status: "cancelled" };
    }
    if (
      !(
        intent?.finished &&
        ["passed", "failed", "cancelled"].includes(job.status)
      )
    ) {
      let session = this.sessions.get(job.id);
      if (!session) {
        const guardedClient = {
          pollRuns: client.pollRuns.bind(client),
          run: client.run.bind(client),
          jobs: client.jobs.bind(client),
          jobLog: client.jobLog.bind(client),
          cancel: async (id: number) => {
            const owned = journal
              .all()
              .find(
                (i) => i.project === job.project_id && i.attempt === job.id,
              );
            if (
              !owned?.identity ||
              owned.externalRun?.run_id !== id ||
              owned.candidate?.ref !== ref
            )
              throw new Error("Probe cancellation scope rejected");
            const { triggering_actor, ...current } = await client.run(id);
            if (
              !sameGithubRun(current, owned.identity) ||
              (triggering_actor && triggering_actor.login !== config.botLogin)
            )
              throw new Error("Probe run identity changed");
            if (current.status !== "completed") await client.cancel(id);
          },
        };
        const poller = new GithubCheckPoller({
          client: guardedClient,
          ...(config.pollIntervalMs
            ? { pollIntervalMs: config.pollIntervalMs }
            : {}),
          ...(config.waitStartMs ? { waitStartMs: config.waitStartMs } : {}),
        });
        const publication = new AbortController();
        const executor = new GithubCheckExecutor({
          config,
          client,
          journal,
          lifecycle: poller,
          context: () => ({
            card: "probe",
            delivery,
            baselineBranch: baseline,
          }),
          push: async (input) => {
            if (input.ref !== ref || input.sha !== job.tested_sha)
              throw new Error("Probe scope rejected");
            if (cancelled()) throw new Error("Probe publication cancelled");
            const result = await this.options.push(job.project_id, input);
            if (cancelled()) publication.abort();
            return result;
          },
          isBaselineAncestor: (sha, branch) =>
            this.options.isBaselineAncestor(job.project_id, sha, branch),
        });
        try {
          const handle = await executor.dispatch({
            signal: publication.signal,
            project: job.project_id,
            attempt: job.id,
            kind: "precheck",
            sha: testedSha,
            tree: treeSha,
            totalTimeoutMs: job.profile.timeout_ms,
            checks: GITHUB_CHECK_NAMES.map((name) => ({ name, run: name })),
          });
          session = { executor, poller, handle };
          const pending = session;
          void executor.poll(handle).then(
            (result) => {
              pending.result = result;
            },
            () => {
              pending.result = {
                status: "executor_unreachable",
                checks: [],
                cleanup_errors: [],
              };
            },
          );
          this.sessions.set(job.id, session);
        } catch (e) {
          return {
            ...job,
            cleanup: e instanceof GithubRetryLater ? "pending" : "held",
          };
        }
      }
      if (job.cancel_requested) await session.executor.cancel(session.handle);
      await session.poller.tick();
      // Promise continuations from the poller settle before the next bounded step.
      if (!session.result) return { ...job, cleanup: "pending" };
      const result = session.result;
      intent = journal
        .all()
        .find((i) => i.project === job.project_id && i.attempt === job.id);
      if (!intent?.finished) return { ...job, cleanup: "held" };
      job = {
        ...job,
        checks: result.checks.map(({ name, status }) => ({ name, status })),
        status: job.cancel_requested
          ? "cancelled"
          : result.status === "passed"
            ? "passed"
            : "failed",
      };
      checkpoint(job);
    }
    intent = journal
      .all()
      .find((i) => i.project === job.project_id && i.attempt === job.id);
    if (
      !intent?.candidate ||
      intent.candidate.ref !== ref ||
      intent.candidate.sha !== job.tested_sha ||
      intent.candidate.repo !== config.repo ||
      intent.executor !== config.name ||
      !intent.finished
    )
      return { ...job, cleanup: "held" };
    const candidate = intent.candidate;
    const exact = intent;
    if (!journal.beginCleanup(exact, () => true))
      return { ...job, cleanup: "held" };
    if (
      !(await this.options.remove(job.project_id, {
        ...candidate,
        token: await client.token(),
      }))
    )
      return { ...job, cleanup: "held" };
    journal.completeCleanup(exact);
    this.sessions.delete(job.id);
    return { ...job, cleanup: "complete" };
  }
}
