import { createHash, randomUUID } from "node:crypto";
import {
  authorizeMacosCheck,
  decisionDelegation,
  type MacosCheckTarget,
  validMacosTestFiles,
} from "@cardigan/domain";
import { PrecheckMergeConflict } from "@cardigan/git-service";
import type {
  CandidateDeleteRequest,
  CandidatePushRequest,
  PushResult,
} from "@cardigan/git-transport";
import {
  fileAttachmentStore,
  loadCommandState,
  type ToolContext,
  ToolError,
  unwrap,
} from "@cardigan/mcp-server";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import type { CheckHandle } from "./check-executor.js";
import { GithubBudgetJournal } from "./github-budget-journal.js";
import {
  GithubCheckExecutor,
  type GithubCheckLifecycle,
} from "./github-check-executor.js";
import {
  GithubClient,
  type GithubRun,
  sameGithubRun,
} from "./github-client.js";
import {
  type ExternalGithubRun,
  GithubDispatchJournal,
} from "./github-dispatch-journal.js";
import { ProbeBudget } from "./github-probe.js";
import { GithubRateLimit, GithubRetryLater } from "./github-rate-limit.js";
import {
  MACOS_CHECK_DEFAULTS,
  MACOS_CHECK_WORKFLOW,
  type MacosCheckProfile,
  type MacosCheckProfiles,
} from "./macos-check-config.js";
import {
  type MacosCheckReport,
  type MacosStepTiming,
  macosCheckSummary,
  macosStepTimings,
  parseMacosCheckLog,
} from "./macos-check-result.js";
import type { GithubMergeGateExecutor } from "./merge-gate-executors.js";

export type MacosCheckStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "not_run";
/** Durable host fact (event `macos_check_job`); never accepted from a caller. */
export interface MacosCheckJob extends MacosCheckTarget {
  readonly id: string;
  readonly files: readonly string[];
  /** 1-based request number for this delivery head. */
  readonly run_number: number;
  readonly created_at: string;
  readonly profile: MacosCheckProfile & { readonly executor: string };
  readonly status: MacosCheckStatus;
  readonly cleanup: "pending" | "complete" | "held";
  readonly reason?: string;
  readonly cancel_requested?: boolean;
  readonly billing?: "public" | "private_delegated";
  readonly tested_sha?: string;
  readonly tree_sha?: string;
  readonly baseline_branch?: string;
  readonly executor_fingerprint?: string;
  readonly run?: { readonly run_id: number; readonly html_url: string };
  readonly report?: MacosCheckReport;
  readonly steps?: readonly MacosStepTiming[];
  readonly attachment_id?: string;
  readonly reported?: boolean;
}
export interface MacosCheckInput {
  readonly test_files: readonly string[];
  readonly idempotency_key: string;
}
type Client = Pick<
  GithubClient,
  | "token"
  | "dispatch"
  | "run"
  | "runs"
  | "jobs"
  | "jobLog"
  | "cancel"
  | "repository"
>;
const TERMINAL: readonly MacosCheckStatus[] = [
  "passed",
  "failed",
  "timed_out",
  "cancelled",
  "not_run",
];
const MAX_LOG_CHARS = 1024 * 1024;
const TIMEOUT = "超过主机监督时限";
export const macosCheckView = (job: MacosCheckJob) => ({
  macos_check_id: job.id,
  card_id: job.card_id,
  delivery_id: job.delivery_id,
  head_sha: job.head_sha,
  files: job.files,
  run_number: job.run_number,
  max_runs_per_candidate: job.profile.max_runs_per_candidate,
  status: job.status,
  ...(job.reason ? { reason: job.reason } : {}),
  ...(job.tested_sha ? { tested_sha: job.tested_sha } : {}),
  ...(job.run ? { run_url: job.run.html_url } : {}),
  ...(job.attachment_id ? { attachment_id: job.attachment_id } : {}),
});
/** Dispatch config: the base executor's App and repository, this fixed workflow. */
export function macosExecutorConfig(
  base: GithubMergeGateExecutor,
  profile: MacosCheckProfile,
): GithubMergeGateExecutor {
  const {
    scopedChecks: _scoped,
    stepContract: _contract,
    infraFlakyRules: _rules,
    ...rest
  } = base;
  return {
    ...rest,
    name: `${base.name}:macos`,
    workflow: MACOS_CHECK_WORKFLOW,
    maxConcurrent: profile.max_concurrent,
  };
}
/**
 * C-611: author- or reviewer-requested macOS run of the current delivery's
 * candidate on a standard GitHub-hosted runner. Shares the MCP frontend
 * (execute) and the sole background host (tick) through durable events.
 */
export class MacosCheckService {
  private working: Promise<void> | undefined;
  private readonly sessions = new Map<
    string,
    { handle: CheckHandle; finish?: () => void; run: ExternalGithubRun }
  >();
  constructor(
    private readonly options: {
      store: Store;
      dataDir: string;
      /** undefined: invalid host file, all projects disabled. */
      profiles: () => MacosCheckProfiles | undefined;
      /** The named GitHub executor, or the project's GitHub merge-gate executor. */
      executor: (
        project: string,
        name?: string,
      ) => GithubMergeGateExecutor | undefined;
      prepare: (
        job: MacosCheckJob,
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
      ) => Client;
      now?: () => number;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  profile(
    project: string,
  ): (MacosCheckProfile & { executor: string }) | undefined {
    const overrides = this.options.profiles();
    if (!overrides) return undefined;
    const profile = { ...MACOS_CHECK_DEFAULTS, ...overrides[project] };
    const base = this.options.executor(project, profile.executor);
    return profile.enabled && base
      ? { ...profile, executor: base.name }
      : undefined;
  }
  jobs(): MacosCheckJob[] {
    const jobs = new Map<string, MacosCheckJob>();
    for (const row of this.options.store.database
      .prepare(
        "SELECT doc FROM events WHERE type = 'macos_check_job' ORDER BY seq",
      )
      .all()) {
      const event = JSON.parse(String(row.doc));
      if (event.actor.kind !== "system") continue;
      jobs.set(event.payload.id, event.payload as MacosCheckJob);
    }
    return [...jobs.values()];
  }
  private save(tx: StoreTransactionContext, job: MacosCheckJob): number {
    const seq = tx.ids.nextEventSequence(job.project_id, job.card_id);
    tx.events.append(job.project_id, {
      id: tx.ids.nextEventId(),
      seq,
      card_id: job.card_id,
      actor: { kind: "system", project_id: job.project_id },
      type: "macos_check_job",
      payload: JSON.parse(JSON.stringify(job)),
      created_at: new Date(this.now()).toISOString(),
    });
    return seq;
  }
  /** A visible entry for the job event just saved in the same transaction. */
  private note(
    tx: StoreTransactionContext,
    job: MacosCheckJob,
    seq: number,
    body: string,
    entry = tx.ids.nextTimelineEntryId(job.project_id, job.card_id),
  ) {
    tx.timeline.put(job.project_id, {
      id: entry,
      short_id: entry,
      card_id: job.card_id,
      event_seq: seq,
      type: "system",
      author: "system",
      body,
      refs: [],
      mentions: [],
      retracted: false,
      created_at: new Date(this.now()).toISOString(),
    });
    return entry;
  }
  /** Persist only forward progress; a requested cancellation is never lost. */
  private checkpoint = (job: MacosCheckJob): MacosCheckJob =>
    this.options.store.uow.run((tx) => {
      const current = this.jobs().find((j) => j.id === job.id);
      if (!current) return job;
      const next = current.cancel_requested
        ? { ...job, cancel_requested: true }
        : job;
      if (JSON.stringify(next) !== JSON.stringify(current)) this.save(tx, next);
      return next;
    });
  async execute(
    context: ToolContext,
    input: MacosCheckInput,
  ): Promise<unknown> {
    context.revalidateToken?.();
    const target = () =>
      this.options.store.uow.read((tx) =>
        unwrap(
          authorizeMacosCheck(
            loadCommandState(tx, context.identity.actor.project_id),
            context.identity.actor,
          ),
        ),
      );
    const before = target();
    if (!validMacosTestFiles(input.test_files))
      throw ToolError.validation(
        "test_files 须为 1-16 个不重复的仓库测试文件（apps/ 或 packages/ 下的 *.test.ts）",
      );
    const files = [...input.test_files];
    const invocation = {
      project_id: before.project_id,
      assignment_id: before.requester.assignment_id,
      key: input.idempotency_key,
      request: { tool: "request_macos_check" as const, params: input },
    };
    return unwrap(
      this.options.store.runIdempotent(invocation, (tx) => {
        context.revalidateToken?.();
        const current = unwrap(
          authorizeMacosCheck(
            loadCommandState(tx, before.project_id),
            context.identity.actor,
          ),
        );
        if (JSON.stringify(current) !== JSON.stringify(before))
          throw new ToolError("stale_target", "请求者或当前交付已变化，请重试");
        const profile = this.profile(current.project_id);
        if (!profile)
          throw new ToolError(
            "illegal_transition",
            "本项目没有可用的 macOS 检查执行器",
          );
        const same = this.jobs().filter(
          (j) =>
            j.project_id === current.project_id &&
            j.card_id === current.card_id &&
            j.delivery_id === current.delivery_id &&
            j.head_sha === current.head_sha,
        );
        const active = same.find(
          (j) =>
            !TERMINAL.includes(j.status) &&
            JSON.stringify(j.files) === JSON.stringify(files),
        );
        if (active) return { ...macosCheckView(active), joined: true };
        if (same.length >= profile.max_runs_per_candidate)
          throw new ToolError(
            "illegal_transition",
            `同一候选已请求 ${same.length} 次，达到主机上限 ${profile.max_runs_per_candidate} 次；新交付可重新请求`,
          );
        const job: MacosCheckJob = {
          ...current,
          id: randomUUID().replaceAll("-", ""),
          files,
          run_number: same.length + 1,
          created_at: new Date(this.now()).toISOString(),
          profile,
          status: "queued",
          cleanup: "pending",
        };
        this.note(
          tx,
          job,
          this.save(tx, job),
          `macOS 检查已排队（第 ${job.run_number}/${profile.max_runs_per_candidate} 次）：${current.delivery_id}（${current.head_sha}）；${files.join("，")}`,
        );
        return macosCheckView(job);
      }),
    ).value;
  }
  tick(): Promise<void> {
    this.working ??= this.cycle().finally(() => {
      this.working = undefined;
    });
    return this.working;
  }
  /** Card closed, requester gone or supervision expired: stop and record why. */
  private stopReason(job: MacosCheckJob): string | undefined {
    if (this.now() - Date.parse(job.created_at) >= job.profile.timeout_ms)
      return TIMEOUT;
    try {
      const open = this.options.store.uow.read((tx) => {
        const c = tx.cards.get(job.project_id, job.card_id);
        return c && !["done", "cancelled"].includes(c.status);
      });
      return open ? undefined : "卡片已关闭";
    } catch {
      return undefined;
    }
  }
  private async cycle(): Promise<void> {
    const jobs = this.options.store.uow.read(() => this.jobs());
    const age = (j: MacosCheckJob) => this.now() - Date.parse(j.created_at);
    // Expired work never holds a slot; it is stopped and reported below.
    let running = jobs.filter(
      (j) =>
        j.status === "running" &&
        j.cleanup !== "complete" &&
        age(j) < j.profile.timeout_ms,
    ).length;
    for (let job of jobs) {
      if (job.cleanup === "complete" && job.reported) continue;
      // Reported results whose remote cleanup stays unconfirmed stop retrying.
      if (
        TERMINAL.includes(job.status) &&
        job.reported &&
        age(job) >= 2 * job.profile.timeout_ms
      )
        continue;
      try {
        if (job.status === "queued") {
          const stop = this.stopReason(job);
          if (stop || job.cancel_requested) {
            job = this.checkpoint({
              ...job,
              status: "cancelled",
              reason: stop ?? "已取消",
              cleanup: "complete",
            });
          } else if (running >= job.profile.max_concurrent) continue;
          else running++;
        }
        if (!TERMINAL.includes(job.status) || job.cleanup !== "complete")
          job = this.checkpoint(await this.advance(job));
      } catch {
        // Keep every persisted step (status, candidate, run); only mark held.
        const current = this.options.store.uow.read(() =>
          this.jobs().find((j) => j.id === job.id),
        );
        job = this.checkpoint({ ...(current ?? job), cleanup: "held" });
      }
      if (TERMINAL.includes(job.status) && !job.reported)
        await this.report(job).catch(() => undefined);
    }
  }
  private client(job: MacosCheckJob, config: GithubMergeGateExecutor) {
    const rate = new ProbeBudget(
      new GithubRateLimit(
        config.restBudgetPerHour,
        Date.now,
        new GithubBudgetJournal(this.options.store, job.profile.executor),
      ),
      job.profile.rest_budget_per_hour,
      new GithubBudgetJournal(this.options.store, config.name),
    );
    return (
      this.options.client?.(config, rate) ??
      new GithubClient({ config, dataDir: this.options.dataDir, rate })
    );
  }
  /** Bounded step; ambiguous external effects stay pending or held. */
  async advance(job: MacosCheckJob): Promise<MacosCheckJob> {
    const base = this.options.executor(job.project_id, job.profile.executor);
    if (!base) return { ...job, cleanup: "held" };
    const config = macosExecutorConfig(base, job.profile);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(config))
      .digest("hex");
    if (job.executor_fingerprint && job.executor_fingerprint !== fingerprint)
      return { ...job, cleanup: "held" };
    const journal = new GithubDispatchJournal(this.options.store, job.card_id);
    const intentOf = () =>
      journal
        .all()
        .find((i) => i.project === job.project_id && i.attempt === job.id);
    let intent = intentOf();
    const client = this.client(job, config);
    const ref = `refs/heads/ci/${job.card_id}/${job.delivery_id}/${job.id}`;
    if (!TERMINAL.includes(job.status)) {
      const stop = this.stopReason(job);
      if (stop || job.cancel_requested)
        job = {
          ...job,
          cancel_requested: true,
          reason: job.reason ?? stop ?? "已取消",
        };
      // Before publication nothing exists remotely; later phases bind and cancel.
      if (
        job.cancel_requested &&
        !intent?.externalRun &&
        (!intent || (intent.phase === "reserved" && !intent.publisher))
      ) {
        if (intent && !intent.finished) journal.finishUnpublishedProbe(intent);
        return {
          ...job,
          status: job.reason === TIMEOUT ? "timed_out" : "cancelled",
          cleanup: "complete",
        };
      }
      if (!job.billing) {
        const repository = await client.repository();
        const delegated = this.options.store.uow.read(
          (tx) =>
            decisionDelegation(
              tx.project_preferences.get(job.project_id, job.project_id),
            ).spending,
        );
        if (repository.private && !delegated)
          return {
            ...job,
            status: "not_run",
            cleanup: "complete",
            reason:
              "私有仓库的托管 macOS 运行会计费，本项目未开启花钱类常驻授权，未运行",
          };
        job = this.checkpoint({
          ...job,
          status: "running",
          billing: repository.private ? "private_delegated" : "public",
          executor_fingerprint: fingerprint,
        });
      }
      if (!job.tested_sha || !job.tree_sha || !job.baseline_branch) {
        try {
          const prepared = await this.options.prepare(job);
          job = this.checkpoint({
            ...job,
            tested_sha: prepared.sha,
            tree_sha: prepared.tree,
            baseline_branch: prepared.baseline,
          });
        } catch (error) {
          return {
            ...job,
            status: "failed",
            cleanup: "complete",
            reason:
              error instanceof PrecheckMergeConflict
                ? "当前交付与基线冲突，未运行"
                : "候选准备失败，未运行",
          };
        }
      }
      // An unconfirmable dispatch ends at the deadline instead of holding a slot.
      const abandon = (): MacosCheckJob => ({
        ...job,
        status: job.reason === TIMEOUT ? "timed_out" : "cancelled",
        reason: `${job.reason ?? "已取消"}；远程运行未能确认`,
        cleanup: "held",
      });
      let session: Awaited<ReturnType<typeof this.session>>;
      try {
        session = await this.session(job, config, client, journal, ref);
      } catch (error) {
        if (stop) return abandon();
        throw error;
      }
      if (!session) return stop ? abandon() : { ...job, cleanup: "pending" };
      const run = await client.run(session.run.run_id);
      if (run.id !== session.run.run_id || run.run_attempt !== 1)
        return { ...job, cleanup: "held" };
      if (run.status !== "completed") {
        if (job.cancel_requested)
          await this.cancel(job, client, journal, ref, run);
        return {
          ...job,
          run: { run_id: run.id, html_url: session.run.html_url },
          cleanup: "pending",
        };
      }
      job = this.checkpoint({
        ...job,
        run: { run_id: run.id, html_url: session.run.html_url },
        ...(await this.result(job, client, run)),
      });
      session.finish?.();
    }
    intent = intentOf();
    if (!intent?.finished) return { ...job, cleanup: "held" };
    if (intent.deleted) {
      this.sessions.delete(job.id);
      return { ...job, cleanup: "complete" };
    }
    const candidate = intent.candidate;
    if (
      !candidate ||
      candidate.ref !== ref ||
      candidate.sha !== job.tested_sha ||
      candidate.repo !== config.repo ||
      intent.executor !== config.name ||
      !journal.beginCleanup(intent, () => true)
    )
      return { ...job, cleanup: "held" };
    if (
      !(await this.options.remove(job.project_id, {
        ...candidate,
        token: await client.token(),
      }))
    )
      return { ...job, cleanup: "held" };
    journal.completeCleanup(intent);
    this.sessions.delete(job.id);
    return { ...job, cleanup: "complete" };
  }
  /** Re-entering dispatch rebinds the durable intent after a restart; it never POSTs twice. */
  private async session(
    job: MacosCheckJob,
    config: GithubMergeGateExecutor,
    client: Client,
    journal: GithubDispatchJournal,
    ref: string,
  ) {
    const existing = this.sessions.get(job.id);
    if (existing) return existing;
    let bound: { finish?: () => void; run?: ExternalGithubRun } = {};
    const lifecycle: GithubCheckLifecycle = {
      register: (run, _request, _identity, onTerminal) => {
        bound = { run, ...(onTerminal ? { finish: onTerminal } : {}) };
      },
      poll: async () => {
        throw new Error("macOS checks poll through the service");
      },
      cancel: async () => {},
      fetchFailureLog: async () => {},
    };
    const executor = new GithubCheckExecutor({
      config,
      client,
      journal,
      lifecycle,
      context: () => ({
        card: job.card_id,
        delivery: job.delivery_id,
        baselineBranch: job.baseline_branch as string,
      }),
      push: async (input) => {
        if (input.ref !== ref || input.sha !== job.tested_sha)
          throw new Error("macOS check scope rejected");
        return this.options.push(job.project_id, input);
      },
      isBaselineAncestor: (sha, branch) =>
        this.options.isBaselineAncestor(job.project_id, sha, branch),
      ...(this.options.now ? { now: this.options.now } : {}),
    });
    try {
      const handle = await executor.dispatch({
        project: job.project_id,
        attempt: job.id,
        kind: "precheck",
        sha: job.tested_sha as string,
        tree: job.tree_sha as string,
        totalTimeoutMs: job.profile.timeout_ms,
        checks: [],
        workflowInputs: { files: job.files.join(" ") },
      });
      if (!bound.run) return undefined;
      const session = {
        handle,
        run: bound.run,
        ...(bound.finish ? { finish: bound.finish } : {}),
      };
      this.sessions.set(job.id, session);
      return session;
    } catch (error) {
      if (error instanceof GithubRetryLater) return undefined;
      throw error;
    }
  }
  private async cancel(
    job: MacosCheckJob,
    client: Client,
    journal: GithubDispatchJournal,
    ref: string,
    current: GithubRun,
  ) {
    const owned = journal
      .all()
      .find((i) => i.project === job.project_id && i.attempt === job.id);
    if (
      !owned?.identity ||
      owned.externalRun?.run_id !== current.id ||
      owned.candidate?.ref !== ref
    )
      return;
    const { triggering_actor: _actor, ...observed } = current;
    const expected =
      owned.boundByDispatchId === true
        ? { ...owned.identity, display_title: observed.display_title }
        : owned.identity;
    if (sameGithubRun(observed as GithubRun, expected))
      await client.cancel(current.id);
  }
  private async result(
    job: MacosCheckJob,
    client: Client,
    run: GithubRun,
  ): Promise<Partial<MacosCheckJob>> {
    const jobs = await client.jobs(run.id);
    const remote = jobs.length === 1 ? jobs[0] : undefined;
    const steps = remote ? macosStepTimings(remote) : [];
    let report: MacosCheckReport | undefined;
    if (remote) {
      let log = "";
      try {
        await client.jobLog(remote.id, () => {
          log = "";
          return (text) => {
            log = (log + text).slice(-MAX_LOG_CHARS);
          };
        });
        report = parseMacosCheckLog(log, job.files);
      } catch {
        report = undefined;
      }
    }
    const candidate = report?.candidate_sha === job.tested_sha;
    const timedOut =
      run.conclusion === "timed_out" ||
      remote?.steps.some((s) => s.conclusion === "timed_out") ||
      !!report?.timeouts.length;
    const status: MacosCheckStatus =
      run.conclusion === "cancelled"
        ? job.reason === TIMEOUT
          ? "timed_out"
          : "cancelled"
        : run.conclusion === "success" &&
            report &&
            candidate &&
            report.exit_code === 0 &&
            report.files.every((f) => f.status === "passed")
          ? "passed"
          : timedOut
            ? "timed_out"
            : "failed";
    return {
      status,
      steps,
      ...(report ? { report } : {}),
      ...(report && !candidate
        ? { reason: "汇总中的候选与本次检查不一致，结果不作通过" }
        : !report && run.conclusion === "success"
          ? { reason: "未取得测试汇总，结果不作通过" }
          : {}),
    };
  }
  /** Timeline entry plus a JSON attachment on the card, written once. */
  private async report(job: MacosCheckJob) {
    const body = macosCheckSummary({
      status: job.status,
      runUrl: job.run?.html_url,
      testedSha: job.tested_sha,
      reason: job.reason,
      report: job.report,
      steps: job.steps,
    });
    const evidence = Buffer.from(
      JSON.stringify(
        {
          ...macosCheckView(job),
          requester: job.requester,
          billing: job.billing ?? null,
          tree_sha: job.tree_sha ?? null,
          report: job.report ?? null,
          steps: job.steps ?? [],
        },
        null,
        2,
      ),
    );
    const sha256 = createHash("sha256").update(evidence).digest("hex");
    const stored = await fileAttachmentStore(this.options.dataDir).put(
      sha256,
      evidence,
    );
    this.options.store.uow.run((tx) => {
      const current = this.jobs().find((j) => j.id === job.id);
      if (!current || current.reported || !TERMINAL.includes(current.status))
        return;
      const project = job.project_id;
      const attachment = tx.ids.nextAttachmentId(project);
      const entry = tx.ids.nextTimelineEntryId(project, job.card_id);
      tx.attachments.put(project, {
        id: attachment,
        sha256,
        mime: "application/json",
        size: evidence.byteLength,
        card_id: job.card_id,
        uploaded_by: "system",
        storage_path: stored.storage_path,
        attach_to: { kind: "timeline_entry", id: entry },
        kind: "evidence",
        original_filename: `macos-check-${job.id}.json`,
      });
      this.note(
        tx,
        job,
        this.save(tx, {
          ...current,
          attachment_id: attachment,
          reported: true,
        }),
        `${body}\n结果附件：${attachment}`,
        entry,
      );
    });
  }
}
