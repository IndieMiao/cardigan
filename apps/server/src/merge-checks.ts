import { randomUUID } from "node:crypto";
import type {
  Actor,
  Clock,
  CommandEffect,
  CommandPorts,
  CommandState,
  DeliveryId,
  GitPublicationGuard,
  MergeCheckView,
  MergePlan,
  MergeResult,
  ProjectId,
  Result,
} from "@cardigan/domain";
import {
  hasPassedMergeCheck,
  latestMergeCheck,
  mergePlan,
  prechecks,
  prepareMergePlan,
  recordMergeCheck,
  recordMergeCheckBlockers,
  recordMergeExecutor,
  recordMergePreparation,
  recordMergeResult,
} from "@cardigan/domain";
import type {
  CentralProject,
  MergeOutcome,
  PreparedMerge,
} from "@cardigan/git-service";
import {
  acquireMergeCheckCapacity,
  type CandidateTestSnapshot,
  CHECKOUT_LIMITS,
  type CheckExecutor,
  CheckExecutorSuspended,
  CheckRecovery,
  type CheckRequest,
  classifyExecutorFailure,
  computeChangeScope,
  createMergeCheckLog,
  createWorkerFailureContext,
  DeploymentInProgress,
  deploymentInProgress,
  ExecutorPreparationError,
  type ExternalGithubRun,
  executorExecution,
  GITHUB_POLL_DEFAULTS,
  GithubBranchCleaner,
  GithubBudgetJournal,
  GithubCheckExecutor,
  GithubCheckPoller,
  GithubClient,
  GithubDispatchJournal,
  type GithubMergeGateExecutor,
  GithubRateLimit,
  GithubRetryLater,
  LOCAL_EXECUTOR,
  type MergeGateConfiguration,
  mergeCheckCapacityAvailable,
  type ProjectMergeGate,
  runCheckExecutor,
  type runInTemporaryCheckout,
  SshCheckExecutor,
  sweepCheckoutOrphans,
  WORKER_EXIT_RULE,
  type WorkerFailureContext,
  type WorkspacePackage,
} from "@cardigan/host";
import { loadCommandState, persistEffect } from "@cardigan/mcp-server";
import type {
  ExecutionConfig,
  recoverCheckDirectory,
} from "@cardigan/runtime-herdr";
import {
  CheckAdmissionClosed,
  CheckHandoffs,
  type Store,
} from "@cardigan/store";
import { type AuthorCheckGit, AuthorPrechecks } from "./author-prechecks.js";
import type { MergeGit } from "./git.js";
import { mergePublicationGuard } from "./merge-publication.js";
import { mergeProjectSettings } from "./merge-push-loop.js";
import { MergeSkipLog } from "./merge-skip-log.js";
import { withPublication } from "./publication-lock.js";

type Candidate = Extract<PreparedMerge, { status: "candidate" }>;
type Settings = Extract<ProjectMergeGate, { status: "enabled" }>;
type WithoutCard<T> = T extends unknown ? Omit<T, "card_id"> : never;
type CheckChange = WithoutCard<Parameters<typeof recordMergeCheck>[2]>;
export interface MergeCheckGit {
  readCandidateTests?(
    project: CentralProject,
    commit: string,
  ): Promise<CandidateTestSnapshot>;
  changedPaths(
    project: CentralProject,
    base: string,
    commit: string,
  ): Promise<readonly string[]>;
  readWorkspace(
    project: CentralProject,
    commit: string,
  ): Promise<readonly WorkspacePackage[]>;
  baseline(project: CentralProject): Promise<string>;
  prepare(project: CentralProject, plan: MergePlan): Promise<PreparedMerge>;
  publish(
    project: CentralProject,
    completion: DeliveryId,
    candidate: Candidate,
    guard: GitPublicationGuard,
  ): Promise<
    | Extract<MergeOutcome, { status: "stale" }>
    | (Extract<MergeOutcome, { status: "merged" }> & {
        readonly tree_sha: string;
      })
  >;
  distribute(
    project: CentralProject,
    execution?: ExecutionConfig,
  ): Promise<void>;
}
export interface MergeCheckOptions {
  readonly configuration: MergeGateConfiguration;
  /** Default target; a project's `executor` overrides it (P2a-12 C). */
  readonly execution: ExecutionConfig;
  readonly run?: typeof runInTemporaryCheckout;
  /** Trusted host provider override; defaults to the existing SSH supervisor. */
  readonly checkExecutor?: CheckExecutor;
  /** Trusted test seam, shared per configured executor. Never an Agent input. */
  readonly githubClient?: (config: GithubMergeGateExecutor) => GithubClient;
  readonly sweep?: typeof sweepCheckoutOrphans;
  readonly recover?: typeof recoverCheckDirectory;
  readonly recoveryInspectionIntervalMs?: number;
}
interface Task {
  project: CentralProject;
  plan: MergePlan;
  settings: Settings;
  entered: string;
  priority: number;
}

/** Persisted queue; the OS execution slot is held by the trusted check supervisor. */
export class MergeChecks {
  private readonly github = new Map<
    string,
    { client: GithubClient; poller: GithubCheckPoller; retryAt: number }
  >();
  private readonly githubCleaners = new Map<string, GithubBranchCleaner>();
  private readonly githubActive = new Map<
    string,
    {
      task: Task;
      check: MergeCheckView;
      poller: GithubCheckPoller;
      run: ExternalGithubRun;
    }
  >();
  private readonly recovery: CheckRecovery;
  private readonly prechecks: AuthorPrechecks;
  private readonly abort = new AbortController();
  private readonly seen = new Set<string>();
  private readonly skips = new MergeSkipLog(
    "merge checks",
    (message) => this.options.report?.(message),
    { now: () => this.options.clock.now() },
  );
  /**
   * C-112: publication re-validates with the confirmed `mergePlan`; its
   * refusals (no confirmation, hold, a merge-blocking action) are logged on
   * their own so a valid preparation plan never clears them.
   */
  private readonly publishSkips = new MergeSkipLog(
    "merge checks publish",
    (message) => this.options.report?.(message),
    { now: () => this.options.clock.now() },
  );
  /**
   * P2a-12 D: one in-flight lane per project (a project never checks or
   * merges two cards in parallel); publication must never wait for it (C-113).
   */
  private readonly lanes = new Map<string, Promise<void>>();
  /** Cards whose check is executing outside the mutex. */
  private readonly active = new Set<string>();
  private readonly sweeps = new Map<
    string,
    { at: number; work: Promise<void> }
  >();
  /** P2a-12 D: per execution target, which `max_concurrent` slots are held, and priority-ordered waiters. */
  private readonly slots = new Map<
    string,
    {
      used: boolean[];
      waiting: {
        next: () => Task | undefined;
        wake: (slot: number | undefined) => void;
      }[];
    }
  >();
  /** Serializes every Git/state step; only the check command runs outside. */
  private exclusive: Promise<void> = Promise.resolve();
  private readonly prepared = new Map<
    string,
    { key: string; value: PreparedMerge }
  >();
  constructor(
    private readonly options: MergeCheckOptions & {
      store: Store;
      git: MergeGit & Partial<MergeCheckGit> & Partial<AuthorCheckGit>;
      clock: Clock;
      onError: (error: unknown) => void;
      /** C-112: informational skip notices (not errors); default discards. */
      report?: (message: string) => void;
    },
  ) {
    this.recovery = new CheckRecovery({
      store: options.store,
      clock: options.clock,
      execution: options.execution,
      executor: (project) => {
        const settings = options.configuration.forProject(project);
        return settings.status === "enabled" ? settings.executor : undefined;
      },
      ...(options.recoveryInspectionIntervalMs !== undefined
        ? { inspectionIntervalMs: options.recoveryInspectionIntervalMs }
        : {}),
      ...(options.recover ? { recover: options.recover } : {}),
    });
    this.prechecks = new AuthorPrechecks({
      ...options,
      git: options.git,
      signal: this.abort.signal,
      onError: (error) => this.report(error),
      recovery: this.recovery,
      ...(options.checkExecutor ? { executor: options.checkExecutor } : {}),
      reserve: (settings) => this.reservePrecheck(settings),
      github: (check, project, settings, bind) => {
        const config = settings.executor;
        if (
          config?.type !== "github" ||
          !options.git.pushCheckCandidate ||
          !options.git.isBaselineAncestor
        )
          throw new Error("GitHub precheck adapter unavailable");
        const { client, poller } = this.githubProvider(config);
        const push = options.git.pushCheckCandidate;
        const ancestor = options.git.isBaselineAncestor;
        return new GithubCheckExecutor({
          config,
          client,
          lifecycle: poller,
          journal: new GithubDispatchJournal(options.store),
          now: () => Date.parse(options.clock.now()),
          context: () => ({
            card: check.card_id,
            delivery: check.assignment_id,
            baselineBranch: project.base_branch,
            onExternalRun: bind,
          }),
          push: (input) => push(project, input),
          isBaselineAncestor: (sha, branch) => ancestor(project, sha, branch),
        });
      },
    });
  }

  stop(): void {
    this.abort.abort();
    for (const pool of this.slots.values())
      for (const waiter of pool.waiting.splice(0)) waiter.wake(undefined);
  }
  /** Resolves when no check lane is in flight. */
  async idle(): Promise<void> {
    while (this.lanes.size) await Promise.all(this.lanes.values());
    await Promise.all([...this.sweeps.values()].map((sweep) => sweep.work));
    await this.prechecks.idle();
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.exclusive.then(work);
    this.exclusive = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  configured(project: ProjectId): boolean {
    return this.options.configuration.forProject(project).status !== "disabled";
  }
  private fenced(project: string): boolean {
    const settings = this.options.configuration.forProject(project);
    const facts = new CheckHandoffs(this.options.store, "");
    return (
      facts.blockedProject(project) ||
      facts.blocked(
        settings.status === "enabled"
          ? (settings.executor?.name ?? LOCAL_EXECUTOR)
          : LOCAL_EXECUTOR,
      )
    );
  }
  private state(project: string) {
    return this.options.store.uow.read((tx) =>
      loadCommandState(
        tx,
        project as ProjectId,
        mergeProjectSettings(this.options.configuration, project),
      ),
    );
  }
  private command<T>(
    project: string,
    reduce: (
      state: CommandState,
      actor: Actor,
      ports: CommandPorts,
    ) => Result<CommandEffect<T>>,
  ): T {
    return this.options.store.uow.run((tx) => {
      const result = reduce(
        loadCommandState(
          tx,
          project as ProjectId,
          mergeProjectSettings(this.options.configuration, project),
        ),
        { kind: "system", project_id: project as ProjectId },
        { ids: tx.ids, clock: this.options.clock },
      );
      if (!result.ok)
        throw new Error(`${result.error.code}: ${result.error.message}`);
      persistEffect(tx, project as ProjectId, result.value);
      return result.value.data;
    });
  }
  private check(task: Task, update: CheckChange, requireAdmission = false) {
    const identity = {
      card_id: task.plan.card_id,
      attempt_id: update.attempt_id,
      completion_id: update.completion_id,
      candidate_sha: update.candidate_sha,
      tree_sha: update.tree_sha,
      ...(update.scope ? { scope: update.scope } : {}),
      ...(update.executor ? { executor: update.executor } : {}),
      ...(update.external_run ? { external_run: update.external_run } : {}),
    };
    return this.command(task.project.project_id, (s, a, p) => {
      if (
        (requireAdmission || update.status === "queued") &&
        this.fenced(task.project.project_id)
      )
        throw new CheckAdmissionClosed();
      const change =
        update.status === "queued" || update.status === "running"
          ? { ...identity, status: update.status }
          : { ...update, ...identity };
      const recorded = recordMergeCheck(s, a, change, p);
      if (
        recorded.ok ||
        !("failure_excerpt" in change) ||
        change.failure_excerpt === undefined ||
        recorded.error.code !== "validation_failed"
      )
        return recorded;
      // Optional diagnostics cannot prevent an otherwise valid terminal fact.
      // The second command still validates every required identity/state field.
      const { failure_excerpt: _excerpt, ...required } = change;
      return recordMergeCheck(s, a, required, p);
    });
  }
  private record(task: Task, result: MergeResult) {
    return this.command(task.project.project_id, (s, a, p) =>
      recordMergeResult(
        s,
        a,
        {
          card_id: task.plan.card_id,
          completion_id: task.plan.completion_id,
          result,
        },
        p,
      ),
    );
  }
  private git(): MergeGit & MergeCheckGit {
    const git = this.options.git;
    if (!git.baseline || !git.prepare || !git.publish || !git.distribute)
      throw new Error("合并闸门缺少 Git 执行入口，拒绝合并");
    return git as MergeGit & MergeCheckGit;
  }
  private valid(task: Task, confirmed = false): boolean {
    const { project_id } = task.project,
      { card_id } = task.plan;
    const plan = (confirmed ? mergePlan : prepareMergePlan)(
      this.state(project_id),
      card_id,
    );
    if (confirmed)
      if (plan.ok) this.publishSkips.ready(project_id, card_id);
      else this.publishSkips.skipped(project_id, card_id, plan.error);
    return plan.ok && JSON.stringify(plan.value) === JSON.stringify(task.plan);
  }
  private passed(task: Task, tree: string): boolean {
    return hasPassedMergeCheck(
      this.state(task.project.project_id).events,
      task.plan.card_id,
      task.plan.completion_id,
      tree,
    );
  }
  private async prepare(task: Task): Promise<PreparedMerge> {
    const git = this.git();
    await git.sync(task.project);
    const baseline = await git.baseline(task.project),
      id = `${task.project.project_id}/${task.plan.card_id}`;
    const key = JSON.stringify([task.project, task.plan, baseline]);
    const cached = this.prepared.get(id);
    const value =
      cached?.key === key
        ? cached.value
        : await git.prepare(task.project, task.plan);
    if (value.status !== "conflicted" && this.valid(task))
      this.command(task.project.project_id, (s, a, p) =>
        recordMergePreparation(
          s,
          a,
          {
            card_id: task.plan.card_id,
            completion_id: task.plan.completion_id,
            base_sha:
              value.status === "noop" ? value.branch_sha : value.previous_sha,
            noop: value.status === "noop",
          },
          p,
        ),
      );
    this.prepared.set(id, { key, value });
    return value;
  }
  private async interrupt(task: Task, check: MergeCheckView) {
    // A queued attempt has no writer; preserve any existing crashed-attempt log.
    try {
      const log = await createMergeCheckLog({
        dataDir: this.options.execution.dataDir,
        project: task.project.project_id,
        attempt: check.attempt_id,
        env: task.settings.env,
      });
      await log.finish({
        status: "interrupted",
        checks: [],
        cleanup_errors: [],
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        this.options.onError(new Error("中断检查的日志无法创建"));
    }
    this.check(
      task,
      {
        ...check,
        status: "interrupted",
        checks: [],
        summary: "检查中断或候选已改变，重新排队",
        log_ref: `${check.attempt_id}.log`,
      },
      true,
    );
    this.seen.delete(check.attempt_id);
  }
  private async queue(
    task: Task,
    candidate: Pick<Candidate, "candidate_sha" | "tree_sha"> & {
      previous_sha?: string;
      scope?: MergeCheckView["scope"];
    },
  ): Promise<MergeCheckView | undefined> {
    const { plan } = task;
    const events = this.state(task.project.project_id).events;
    const latest = latestMergeCheck(events, plan.card_id, plan.completion_id);
    if (
      task.settings.executor?.type === "github" &&
      latest?.executor?.type === "github" &&
      latest.executor.name === task.settings.executor.name &&
      (latest.recheck_requested ||
        !["queued", "running"].includes(latest.status)) &&
      new GithubDispatchJournal(this.options.store).hasUnboundIntent(
        task.project.project_id,
        task.plan.card_id,
        latest.attempt_id,
      )
    )
      // A rejected/unknown binding still owns its reservation. Keep its fixed
      // diagnosis; a new attempt cannot supersede the unresolved remote intent.
      return undefined;
    if (
      latest &&
      ["running", "queued"].includes(latest.status) &&
      !latest.recheck_requested
    ) {
      if (
        this.seen.has(latest.attempt_id) &&
        latest.status === "queued" &&
        latest.candidate_sha === candidate.candidate_sha &&
        latest.tree_sha === candidate.tree_sha
      )
        return latest;
      if (
        task.settings.executor?.type === "github" &&
        latest.executor?.type === "github" &&
        latest.executor.name === task.settings.executor.name &&
        latest.candidate_sha === candidate.candidate_sha &&
        latest.tree_sha === candidate.tree_sha
      )
        return latest;
      await this.interrupt(task, latest);
    }
    if (this.passed(task, candidate.tree_sha)) return undefined;
    const previous = latestMergeCheck(
      this.state(task.project.project_id).events,
      plan.card_id,
      plan.completion_id,
      candidate.tree_sha,
    );
    if (
      previous &&
      previous.status !== "interrupted" &&
      previous.status !== "executor_unreachable" &&
      !previous.recheck_requested
    )
      return undefined;
    const scope = candidate.previous_sha
      ? await this.scope(task, candidate.previous_sha, candidate.candidate_sha)
      : candidate.scope;
    const queued = this.check(task, {
      completion_id: plan.completion_id,
      attempt_id: randomUUID(),
      candidate_sha: candidate.candidate_sha,
      tree_sha: candidate.tree_sha,
      ...(scope ? { scope } : {}),
      status: "queued",
      ...(task.settings.executor
        ? {
            executor: {
              name: task.settings.executor.name,
              type: task.settings.executor.type ?? "ssh",
            },
          }
        : {}),
    });
    this.seen.add(queued.attempt_id);
    return queued;
  }
  private async scope(
    task: Task,
    base: string,
    commit: string,
  ): Promise<MergeCheckView["scope"]> {
    if (
      !task.settings.checks.some(
        (check) => check.scope === "affected" || check.skipDocsOnly,
      )
    )
      return undefined;
    const git = this.git();
    if (!git.changedPaths || !git.readWorkspace)
      throw new Error("分层检查缺少变更范围读取入口，拒绝合并");
    const paths = await git.changedPaths(task.project, base, commit);
    // Docs/global changes need no workspace; affected checks read the candidate, never HEAD.
    let scope = computeChangeScope({ paths, workspace: [] });
    if (scope.kind === "full" && scope.reason === "unknown_package")
      scope = computeChangeScope({
        paths,
        workspace: await git.readWorkspace(task.project, commit),
        ...(task.settings.affected?.extraDependents
          ? { extraDependents: task.settings.affected.extraDependents }
          : {}),
      });
    return scope.kind === "affected" ? scope : { kind: scope.kind };
  }
  private terminal(task: Task, prepared: Exclude<PreparedMerge, Candidate>) {
    if (prepared.status === "conflicted")
      this.record(task, {
        kind: "conflicted",
        delivery_id: prepared.delivery_id as DeliveryId,
        files: prepared.files,
      });
    else if (this.valid(task, true))
      this.record(task, {
        kind: "merged",
        merge_sha: prepared.branch_sha,
        previous_sha: prepared.branch_sha,
        noop: true,
      });
  }
  /**
   * P2a-12 C: the project's configured executor, else the default execution.
   * Never falls back from a configured executor to the default.
   */
  private target(task: Task): ExecutionConfig {
    return task.settings.executor
      ? executorExecution(task.settings.executor, this.options.execution)
      : this.options.execution;
  }
  /**
   * P2a-12 D: hold one of the target's `max_concurrent` slots (local: one,
   * as before). Waits by live priority and then FIFO; undefined after shutdown.
   */
  private async slot(
    task: Pick<Task, "settings">,
    nextTask: () => Task | undefined,
  ): Promise<{ index: number; release: () => void } | undefined> {
    const bucket = task.settings.executor?.name ?? LOCAL_EXECUTOR;
    const limit = task.settings.executor?.maxConcurrent ?? 1;
    let pool = this.slots.get(bucket);
    if (!pool) {
      pool = { used: [], waiting: [] };
      this.slots.set(bucket, pool);
    }
    const held = pool;
    let index: number | undefined;
    for (let i = 0; i < limit; i++)
      if (!held.used[i]) {
        index = i;
        break;
      }
    if (index === undefined) {
      if (this.abort.signal.aborted) return undefined;
      // A released slot is handed over directly, so nobody can jump the queue.
      index = await new Promise<number | undefined>((resolve) =>
        held.waiting.push({ next: nextTask, wake: resolve }),
      );
      if (index === undefined) return undefined;
    }
    held.used[index] = true;
    const taken = index;
    let released = false;
    return {
      index: taken,
      release: () => {
        if (released) return;
        released = true;
        const ranked = held.waiting
          .map((waiter) => {
            try {
              return { waiter, task: waiter.next() };
            } catch (error) {
              this.report(error);
              return { waiter, task: undefined };
            }
          })
          .sort((a, b) =>
            a.task && b.task
              ? this.compare(a.task, b.task)
              : a.task
                ? -1
                : b.task
                  ? 1
                  : 0,
          );
        held.waiting = ranked.map(({ waiter }) => waiter);
        const next = held.waiting.shift();
        if (next) next.wake(taken);
        else held.used[taken] = false;
      },
    };
  }
  /** Q-486: reserve only a free target slot after every executable merge. */
  private async reservePrecheck(settings: Settings) {
    const target = settings.executor;
    if (!target || this.abort.signal.aborted) return;
    const tasks = this.tasks(
      this.options.store.listProjects().map((p) => p.id),
    );
    if (
      tasks.some((task) => {
        if (
          (task.settings.executor?.name ?? LOCAL_EXECUTOR) !== target.name ||
          !this.capacity(task)
        )
          return false;
        const check = latestMergeCheck(
          this.state(task.project.project_id).events,
          task.plan.card_id,
          task.plan.completion_id,
        );
        return (
          !check ||
          check.recheck_requested ||
          ["queued", "running", "interrupted", "executor_unreachable"].includes(
            check.status,
          )
        );
      })
    )
      return;
    const pool = this.slots.get(target.name);
    if (
      pool?.waiting.length ||
      (pool?.used.filter(Boolean).length ?? 0) >= target.maxConcurrent ||
      !mergeCheckCapacityAvailable(
        this.options.store,
        target.name,
        target.maxConcurrent,
      )
    )
      return;
    return this.slot({ settings }, () => undefined);
  }
  /**
   * P2a-12 D: live checks recorded by other controller processes also count
   * against a remote executor's `max_concurrent`; a full target leaves the
   * check queued for a later pass. Local checks keep today's behavior.
   */
  private capacity(task: Task): boolean {
    if (this.fenced(task.project.project_id)) return false;
    const executor = task.settings.executor;
    if (
      this.options.store.uow.read(() =>
        deploymentInProgress(this.options.store),
      )
    )
      return false;
    if (executor?.type === "github") {
      if (
        Date.parse(this.options.clock.now()) <
        (this.github.get(executor.name)?.retryAt ?? 0)
      )
        return false;
      const inFlight = new GithubDispatchJournal(this.options.store)
        .unfinished()
        .filter((intent) => intent.executor === executor.name);
      const latest = latestMergeCheck(
        this.state(task.project.project_id).events,
        task.plan.card_id,
        task.plan.completion_id,
      );
      if (
        !inFlight.some(
          (intent) =>
            intent.project === task.project.project_id &&
            intent.attempt === latest?.attempt_id,
        ) &&
        inFlight.length >= executor.maxConcurrent
      )
        return false;
    }
    return (
      !executor ||
      mergeCheckCapacityAvailable(
        this.options.store,
        executor.name,
        executor.maxConcurrent,
      )
    );
  }
  private executor(
    task: Task,
    status: "reachable" | "poll" | "unreachable",
    attempt?: string,
  ) {
    const executor = task.settings.executor;
    if (!executor) return undefined;
    return this.command(task.project.project_id, (s, a, p) =>
      recordMergeExecutor(
        s,
        a,
        status === "unreachable"
          ? { executor: executor.name, status, attempt_id: attempt ?? "" }
          : { executor: executor.name, status },
        p,
      ),
    );
  }
  private githubProvider(config: GithubMergeGateExecutor) {
    let shared = this.github.get(config.name);
    if (!shared) {
      const now = () => Date.parse(this.options.clock.now());
      const client =
        this.options.githubClient?.(config) ??
        new GithubClient({
          config,
          dataDir: this.options.execution.dataDir,
          now,
          rate: new GithubRateLimit(
            config.restBudgetPerHour,
            now,
            new GithubBudgetJournal(this.options.store, config.name),
          ),
        });
      const poller = new GithubCheckPoller({
        client,
        now,
        onError: (error) => this.report(error),
        ...(config.pollIntervalMs
          ? { pollIntervalMs: config.pollIntervalMs }
          : {}),
        ...(config.waitStartMs ? { waitStartMs: config.waitStartMs } : {}),
      });
      shared = { client, poller, retryAt: 0 };
      this.github.set(config.name, shared);
    }
    return shared;
  }
  private githubExecutor(
    task: Task,
    check: MergeCheckView,
    config: GithubMergeGateExecutor,
    bind: (run: ExternalGithubRun) => void,
  ): CheckExecutor {
    const { client, poller } = this.githubProvider(config);
    const { pushCheckCandidate, isBaselineAncestor } = this.options.git;
    if (!pushCheckCandidate || !isBaselineAncestor)
      throw new Error("GitHub 检查缺少受信 Git 适配器");
    return new GithubCheckExecutor({
      config,
      client,
      lifecycle: poller,
      journal: new GithubDispatchJournal(this.options.store),
      now: () => Date.parse(this.options.clock.now()),
      context: () => ({
        card: task.plan.card_id,
        delivery: task.plan.completion_id,
        baselineBranch: task.project.base_branch,
        onExternalRun: (run) => {
          bind(run);
          this.githubActive.set(check.attempt_id, { task, check, run, poller });
        },
      }),
      push: (input) =>
        pushCheckCandidate.call(this.options.git, task.project, input),
      isBaselineAncestor: (sha, branch) =>
        isBaselineAncestor.call(this.options.git, task.project, sha, branch),
    });
  }
  private async execute(
    task: Task,
    check: MergeCheckView,
    slot: number,
  ): Promise<void> {
    let log: Awaited<ReturnType<typeof createMergeCheckLog>> | undefined;
    let result: Awaited<ReturnType<typeof runInTemporaryCheckout>>;
    let releaseCapacity: ReturnType<typeof acquireMergeCheckCapacity>;
    let connected = false;
    let bound = check.external_run;
    const executedOn = task.settings.executor;
    // Reserve before any worker can execute, including the ready handshake window.
    try {
      releaseCapacity = acquireMergeCheckCapacity(
        this.options.store,
        task.project.project_id as ProjectId,
        check.attempt_id,
        undefined,
        task.settings.executor?.name ?? LOCAL_EXECUTOR,
      );
    } catch (error) {
      if (
        !(error instanceof DeploymentInProgress) &&
        !(error instanceof CheckAdmissionClosed)
      )
        throw error;
      return; // Keep the check queued; deployment does not change its result.
    }
    const workerIdentity = {
      project_id: task.project.project_id,
      card_id: task.plan.card_id,
      completion_id: check.completion_id,
      attempt_id: check.attempt_id,
      candidate_sha: check.candidate_sha,
      tree_sha: check.tree_sha,
    };
    let workerContext: WorkerFailureContext | undefined;
    if (executedOn?.infraFlakyRules?.includes(WORKER_EXIT_RULE)) {
      try {
        const snapshot = await this.git().readCandidateTests?.(
          task.project,
          check.candidate_sha,
        );
        if (snapshot)
          workerContext = createWorkerFailureContext(
            workerIdentity,
            snapshot,
            executedOn.type === "github" ? "github" : "ssh",
            check.scope,
          );
      } catch {
        this.options.onError(
          new Error("候选测试文件集合不可用，保守拒绝偶发分类"),
        );
      }
    }
    try {
      log = await createMergeCheckLog({
        dataDir: this.options.execution.dataDir,
        project: task.project.project_id,
        attempt: check.attempt_id,
        env: task.settings.env,
        ...(executedOn?.infraFlakyRules
          ? { infraFlakyRules: executedOn.infraFlakyRules }
          : {}),
        workerIdentity,
        ...(workerContext ? { workerContext } : {}),
        ...(executedOn?.type === "github"
          ? {
              resume: true,
              failureExcerptBytes:
                executedOn.failureExcerptBytes ??
                GITHUB_POLL_DEFAULTS.failureExcerptBytes,
            }
          : {}),
      });
      const execution =
        executedOn?.type === "github"
          ? this.options.execution
          : this.target(task);
      const executor =
        (executedOn?.type === "github"
          ? this.githubExecutor(task, check, executedOn, (run) => {
              bound = run;
            })
          : this.options.checkExecutor) ??
        new SshCheckExecutor({
          execution,
          distribute: () =>
            this.serial(async () => {
              await this.git().distribute(task.project, execution);
              connected = true;
              if (!this.valid(task)) throw new Error("Merge target changed");
            }),
          ...(this.options.run ? { run: this.options.run } : {}),
        });
      result = await runCheckExecutor(
        executor,
        {
          kind: "merge_check",
          project: task.project.project_id,
          attempt: check.attempt_id,
          sha: check.candidate_sha,
          tree: check.tree_sha,
          checks: task.settings.checks.map((step) => ({
            name: step.name,
            run: step.run,
            ...(step.timeoutMs !== undefined
              ? { timeoutMs: step.timeoutMs }
              : {}),
            ...(check.scope?.kind === "docs_only" && step.skipDocsOnly
              ? { skipReason: "docs_only" as const }
              : {}),
            ...(step.scope === "affected"
              ? {
                  affectedPaths:
                    check.scope?.kind === "affected"
                      ? (check.scope.packages ?? [])
                      : [],
                }
              : {}),
          })),
          env: task.settings.env,
          totalTimeoutMs: task.settings.totalTimeoutMs,
          serialize: true,
          lockSlot: slot,
          ...(executedOn?.type === "github"
            ? { hostSignal: this.abort.signal }
            : { signal: this.abort.signal }),
          ...(workerContext
            ? {
                onVerifiedCheckout: (
                  context: Parameters<
                    NonNullable<CheckRequest["onVerifiedCheckout"]>
                  >[0],
                ) => {
                  log?.verifiedCheckout(context);
                },
              }
            : {}),
          onReady: (owner) => {
            releaseCapacity.transfer(owner);
            this.executor(task, "reachable");
            this.check(task, {
              ...check,
              ...(bound ? { external_run: bound } : {}),
              status: "running",
            });
          },
          ...(executedOn
            ? {
                onRegistered: (
                  binding: Parameters<CheckRecovery["register"]>[4],
                ) =>
                  this.recovery.register(
                    task.project.project_id as ProjectId,
                    task.plan.card_id,
                    check.attempt_id,
                    check.candidate_sha,
                    binding,
                    executedOn,
                  ),
              }
            : {}),
          onOutput: (name, text) => log?.append(name, text),
        },
        (error) => this.report(error),
      );
    } catch (error) {
      if (executedOn?.type === "github") {
        if (error instanceof CheckExecutorSuspended) return;
        if (error instanceof GithubRetryLater) {
          const provider = this.github.get(executedOn.name);
          if (provider)
            provider.retryAt = Math.max(provider.retryAt, error.retryAt);
          return;
        }
      }
      const failure =
        task.settings.executor && !(error instanceof ExecutorPreparationError)
          ? classifyExecutorFailure(error)
          : undefined;
      if (failure === "repository_missing") connected = true;
      // Never expose raw Git/SSH diagnostics or configured environment values.
      result = {
        status: this.abort.signal.aborted
          ? "interrupted"
          : failure === "executor_unreachable"
            ? "executor_unreachable"
            : "failed",
        checks: [],
        cleanup_errors: [],
        reason:
          failure === "executor_unreachable"
            ? "远程检查机 SSH 连接失败，合并检查排队等待重试"
            : failure === "repository_missing"
              ? "远程检查机的基础仓库缺失或无效，请先初始化基础 clone，再重新检查"
              : error instanceof ExecutorPreparationError
                ? error.summary
                : "候选同步或检查执行入口失败，请检查执行环境",
      };
    } finally {
      // Always release runtime occupancy, even if a returned/cancelled target
      // makes the subsequent business result command reject.
      releaseCapacity();
    }
    // Unconfigured projects keep their previous entry-failure behavior.
    if (!task.settings.executor && result.status === "executor_unreachable")
      result = {
        ...result,
        status: "failed",
        reason: "检查执行入口 SSH 连接失败，请修复执行环境后重新检查",
      };
    const transientDiscovery =
      result.status === "interrupted" ||
      (result.status === "executor_unreachable" &&
        ["api", "dispatch_unknown", "recovery_incomplete"].some(
          (category) => result.reason === `检查执行器不可用：${category}`,
        ));
    if (
      result.status === "executor_unreachable" &&
      (executedOn?.type !== "github" || bound || transientDiscovery)
    )
      this.executor(task, "unreachable", check.attempt_id);
    else if (connected && !this.abort.signal.aborted)
      this.executor(task, "reachable");
    let finished: {
      status: Exclude<MergeCheckView["status"], "running" | "queued">;
      checks: MergeCheckView["checks"];
      summary: string;
      log_ref: string;
      /** C-116: the supervisor saw only timeouts; drives one automatic rerun. */
      timeout_only?: boolean;
      infra_flaky?: boolean;
      failure_excerpt?: string;
    };
    try {
      finished = log
        ? await log.finish(result)
        : {
            ...result,
            summary: "检查日志无法创建，检查未执行",
            log_ref: `${check.attempt_id}.log`,
          };
    } catch {
      finished = {
        status:
          result.status === "executor_unreachable"
            ? "executor_unreachable"
            : "failed",
        checks: [],
        summary: "检查日志写入失败，拒绝发布",
        log_ref: `${check.attempt_id}.log`,
      };
    }
    if (executedOn?.type === "github" && !this.valid(task)) {
      this.githubActive.delete(check.attempt_id);
      this.seen.delete(check.attempt_id);
      return;
    }
    if (
      executedOn?.type === "github" &&
      !bound &&
      ["executor_unreachable", "interrupted"].includes(finished.status) &&
      transientDiscovery &&
      new GithubDispatchJournal(this.options.store).hasUnboundIntent(
        task.project.project_id,
        task.plan.card_id,
        check.attempt_id,
      )
    ) {
      // Keep the original queued attempt as the recovery target. Creating a
      // new attempt would conflict with this durable card reservation forever.
      // Existing executor backoff and REST budgets still control the retry.
      this.seen.delete(check.attempt_id);
      return;
    }
    this.check(task, {
      ...check,
      ...(bound ? { external_run: bound } : {}),
      status: finished.status,
      checks: finished.checks,
      summary: finished.summary,
      log_ref: finished.log_ref,
      timeout_only: finished.timeout_only === true,
      infra_flaky: finished.infra_flaky === true,
      ...(executedOn?.type === "github" && finished.failure_excerpt
        ? { failure_excerpt: finished.failure_excerpt }
        : {}),
    });
    this.githubActive.delete(check.attempt_id);
    this.seen.delete(check.attempt_id);
    if (
      executedOn?.type !== "github" &&
      finished.status === "executor_unreachable" &&
      this.valid(task)
    )
      await this.queue(task, check);
  }
  private failedCompletion(task: Task): boolean {
    const latest = latestMergeCheck(
      this.state(task.project.project_id).events,
      task.plan.card_id,
      task.plan.completion_id,
    );
    return (
      !!latest &&
      ["failed", "timed_out"].includes(latest.status) &&
      !latest.recheck_requested
    );
  }
  private async publish(task: Task) {
    if (this.failedCompletion(task)) return;
    if (this.fenced(task.project.project_id)) return;
    if (this.abort.signal.aborted || !this.valid(task, true)) return;
    const candidate = await this.prepare(task);
    if (candidate.status !== "candidate") {
      this.terminal(task, candidate);
      return;
    }
    if (!this.passed(task, candidate.tree_sha)) {
      await this.queue(task, candidate);
      return;
    }
    await this.release(task, candidate);
  }
  /** Publish only a confirmed candidate whose exact tree already passed. */
  private async ready(task: Task) {
    if (this.fenced(task.project.project_id)) return;
    if (this.abort.signal.aborted || !this.valid(task, true)) return;
    const latest = latestMergeCheck(
      this.state(task.project.project_id).events,
      task.plan.card_id,
      task.plan.completion_id,
    );
    if (latest?.status !== "passed") return;
    const candidate = await this.prepare(task);
    if (
      candidate.status === "candidate" &&
      this.passed(task, candidate.tree_sha)
    )
      await this.release(task, candidate);
  }
  private async release(task: Task, candidate: Candidate) {
    if (this.fenced(task.project.project_id)) return;
    // Re-read confirmation/state after Git IO. CAS protects against another baseline writer.
    if (!this.valid(task, true)) return;
    // C-94: moving central main and recording the move share one lock with
    // the pre-push check, so an unrecorded window is never observed.
    await withPublication(task.project.project_id, async () => {
      if (this.fenced(task.project.project_id)) return;
      if (this.abort.signal.aborted || !this.valid(task, true)) return;
      await this.git().publish(
        task.project,
        task.plan.completion_id,
        candidate,
        mergePublicationGuard({
          store: this.options.store,
          project: task.project.project_id as ProjectId,
          plan: task.plan,
          clock: this.options.clock,
          settings: mergeProjectSettings(
            this.options.configuration,
            task.project.project_id,
          ),
          stopped: () =>
            this.abort.signal.aborted || this.fenced(task.project.project_id),
          result: {
            kind: "merged",
            merge_sha: candidate.candidate_sha,
            previous_sha: candidate.previous_sha,
            tree_sha: candidate.tree_sha,
          },
        }),
      );
    });
  }
  private failure(task: Task, error: unknown) {
    if (error instanceof CheckAdmissionClosed) return;
    this.options.onError(error);
    if (!this.valid(task)) return;
    if (
      !this.state(task.project.project_id).events.some(
        (e) =>
          e.type === "merge_failed" &&
          (e.payload as { completion_id?: string } | null)?.completion_id ===
            task.plan.completion_id,
      )
    )
      this.record(task, {
        kind: "failed",
        reason: "合并候选准备或结果记录失败，未发布未经检查的代码",
      });
  }
  /** Awaits the check round this call started, or only the publish pass. */
  async tick(projects: readonly ProjectId[]): Promise<void> {
    await (await this.schedule(projects)).done;
  }
  /**
   * Each pass independently publishes confirmed candidates whose tree passed,
   * including projects waiting in executor backoff or running another check
   * (C-113). Idle projects then start check lanes in the background; unchecked
   * candidates use live priority, FIFO ties and the executor's retry deadline.
   */
  async schedule(
    projects: readonly ProjectId[],
  ): Promise<{ readonly done: Promise<void> }> {
    if (this.abort.signal.aborted) return { done: Promise.resolve() };
    const journal = new GithubDispatchJournal(this.options.store);
    const hasGithub = projects.some((project) => {
      const settings = this.options.configuration.forProject(project);
      return (
        settings.status === "enabled" && settings.executor?.type === "github"
      );
    });
    for (const intent of hasGithub ? journal.unfinished() : []) {
      if (
        !projects.includes(intent.project as ProjectId) ||
        !intent.externalRun ||
        !intent.identity
      )
        continue;
      const settings = this.options.configuration.forProject(intent.project);
      if (
        settings.status !== "enabled" ||
        settings.executor?.type !== "github" ||
        settings.executor.name !== intent.executor
      )
        continue;
      const state = this.state(intent.project);
      if (intent.identity.display_title.split("/")[4] === "precheck") {
        const author = prechecks(state.events).find(
          (c) => c.attempt_id === intent.attempt,
        );
        if (author && ["queued", "running"].includes(author.status)) continue;
      }
      const delivery = intent.identity.display_title.split(
        "/",
      )[2] as DeliveryId;
      const latest = latestMergeCheck(
        state.events,
        intent.card as never,
        delivery,
      );
      const plan = prepareMergePlan(state, intent.card as never);
      const card = state.cards.find((card) => card.id === intent.card);
      if (
        plan.ok &&
        plan.value.completion_id === delivery &&
        card?.status === "awaiting_merge" &&
        latest?.attempt_id === intent.attempt &&
        ["queued", "running"].includes(latest.status)
      )
        continue;
      const { poller } = this.githubProvider(settings.executor);
      poller.register(
        intent.externalRun,
        {
          project: intent.project,
          kind: "merge_check",
          sha: "0".repeat(40),
          tree: "0".repeat(40),
          checks: settings.checks,
        },
        intent.identity,
        () => journal.finish(intent),
      );
      void poller.cancel(intent.externalRun).catch(() => {});
    }
    // Same trusted scheduling boundary drives all remote lifecycle work.
    for (const state of this.githubActive.values()) {
      if (!this.valid(state.task))
        void state.poller.cancel(state.run).catch(() => {});
    }
    await Promise.all(
      [...this.github.values()].map(({ poller }) => poller.tick()),
    );
    // Cleanup is diagnostic-only and follows the D4 maintenance cadence.
    for (const projectId of projects) {
      const settings = this.options.configuration.forProject(projectId);
      if (
        settings.status !== "enabled" ||
        settings.executor?.type !== "github" ||
        !this.options.git.deleteCheckCandidate
      )
        continue;
      const config = settings.executor;
      let cleaner = this.githubCleaners.get(JSON.stringify(config));
      if (!cleaner) {
        const { client } = this.githubProvider(config);
        cleaner = new GithubBranchCleaner({
          store: this.options.store,
          config,
          now: () => Date.parse(this.options.clock.now()),
          token: () => client.token(),
          remove: (id, request) => {
            const project = this.options.git.projectOf(id as ProjectId);
            return project && this.options.git.deleteCheckCandidate
              ? this.options.git.deleteCheckCandidate(project, {
                  ...request,
                  signal: this.abort.signal,
                })
              : Promise.resolve(false);
          },
          onError: () =>
            this.report(new Error("GitHub 候选分支清理失败，将在维护周期重试")),
        });
        this.githubCleaners.set(JSON.stringify(config), cleaner);
      }
      const eligibleProjects = projects.filter((id) => {
        const current = this.options.configuration.forProject(id);
        return (
          current.status === "enabled" &&
          current.executor?.type === "github" &&
          current.executor.name === config.name
        );
      });
      void cleaner.tick(eligibleProjects);
    }
    let tasks: Task[];
    try {
      this.sweep(projects);
      tasks = this.tasks(projects);
    } catch (error) {
      this.report(error);
      return { done: Promise.resolve() };
    }
    if (tasks.length)
      await this.serial(async () => {
        for (const task of tasks) {
          if (this.abort.signal.aborted) return;
          if (this.active.has(this.key(task))) continue;
          try {
            await this.ready(task);
          } catch (error) {
            this.failure(task, error);
          }
        }
      });
    const fresh = new Map<string, Task[]>();
    for (const task of tasks) {
      const id = task.project.project_id;
      if (this.lanes.has(id) || !this.valid(task)) continue;
      fresh.set(id, [...(fresh.get(id) ?? []), task]);
    }
    const live = new Set(tasks.map((t) => this.key(t)));
    for (const key of this.prepared.keys()) {
      const project = key.slice(0, key.indexOf("/"));
      if (
        projects.includes(project as ProjectId) &&
        !this.lanes.has(project) &&
        !live.has(key)
      )
        this.prepared.delete(key);
    }
    const started: Promise<void>[] = [];
    for (const [id, list] of fresh) {
      // Nobody may await a background lane: it must never reject, even when
      // the error reporter itself throws.
      const lane = this.run(list)
        .catch((error: unknown) => this.report(error))
        .finally(() => {
          if (this.lanes.get(id) === lane) this.lanes.delete(id);
        });
      this.lanes.set(id, lane);
      started.push(lane);
    }
    const author = await this.prechecks.schedule(projects);
    return { done: Promise.all([...started, author.done]).then(() => {}) };
  }
  private report(error: unknown): void {
    try {
      this.options.onError(error);
    } catch {
      // The reporter failed too; there is nobody left to tell.
    }
  }
  /** Runs at startup and periodically, including when no card can acquire a lane. */
  private sweep(projects: readonly ProjectId[]): void {
    const targets = new Map<
      string,
      { execution: ReturnType<typeof executorExecution>; projects: ProjectId[] }
    >();
    for (const project of projects) {
      if (this.fenced(project)) continue;
      const settings = this.options.configuration.forProject(project);
      if (
        settings.status !== "enabled" ||
        !settings.executor ||
        settings.executor.type === "github"
      )
        continue;
      const name = settings.executor.name;
      const target = targets.get(name);
      if (target) {
        if (!target.projects.includes(project)) target.projects.push(project);
      } else
        targets.set(name, {
          execution: executorExecution(
            settings.executor,
            this.options.execution,
          ),
          projects: [project],
        });
    }
    for (const [name, target] of targets) {
      const project = target.projects[0];
      if (!project) continue;
      const at = Date.parse(this.options.clock.now());
      const previous = this.sweeps.get(name);
      if (previous && at - previous.at < CHECKOUT_LIMITS.sweepIntervalMs)
        continue;
      const entry = { at: Number.POSITIVE_INFINITY, work: Promise.resolve() };
      this.sweeps.set(name, entry);
      // A pre-existing sweep is part of drain too. No sweep may slip in after the fence.
      let releaseSweep: ReturnType<typeof acquireMergeCheckCapacity>;
      try {
        releaseSweep = acquireMergeCheckCapacity(
          this.options.store,
          project,
          `sweep-${randomUUID()}`,
          undefined,
          name,
        );
      } catch (error) {
        this.sweeps.delete(name);
        if (
          !(error instanceof CheckAdmissionClosed) &&
          !(error instanceof DeploymentInProgress)
        )
          this.report(error);
        continue;
      }
      entry.work = Promise.resolve()
        .then(() =>
          (this.options.sweep ?? sweepCheckoutOrphans)(
            target.execution,
            (record) =>
              this.report(new Error(`远程检查孤儿清理 ${name}: ${record}`)),
          ),
        )

        .catch(() =>
          this.report(new Error(`远程检查孤儿巡检失败（${name}），下轮重试`)),
        )
        .then(async () => {
          for (const project of target.projects) {
            try {
              await this.recovery.sweep(project);
            } catch {
              this.report(
                new Error(
                  `远程检查目录恢复失败（${name}/${project}），保留现场`,
                ),
              );
            }
          }
        })
        .finally(() => {
          releaseSweep();
          entry.at = Date.parse(this.options.clock.now());
        });
    }
  }
  private key(task: Task): string {
    return `${task.project.project_id}/${task.plan.card_id}`;
  }
  private tasks(projects: readonly ProjectId[]): Task[] {
    const tasks: Task[] = [];
    for (const id of projects) {
      if (this.fenced(id)) continue;
      const settings = this.options.configuration.forProject(id),
        project = this.options.git.projectOf(id);
      if (settings.status !== "disabled")
        this.command(id, (s, a, p) =>
          recordMergeCheckBlockers(
            s,
            a,
            settings.status === "invalid" ||
              (settings.status === "enabled" &&
                settings.executor?.type === "github" &&
                (!this.options.git.pushCheckCandidate ||
                  !this.options.git.isBaselineAncestor))
              ? { unavailable: "configuration" }
              : !project
                ? { unavailable: "repository" }
                : {},
            p,
          ),
        );
      if (settings.status !== "enabled" || !project) continue;
      if (
        settings.executor?.type === "github" &&
        (!this.options.git.pushCheckCandidate ||
          !this.options.git.isBaselineAncestor)
      )
        continue;
      const state = this.state(id);
      const awaiting = new Set(
        state.cards
          .filter((c) => c.status === "awaiting_merge")
          .map((c) => c.id),
      );
      this.skips.retain(id, awaiting);
      this.publishSkips.retain(id, awaiting);
      for (const card of state.cards) {
        if (card.status !== "awaiting_merge") continue;
        const plan = prepareMergePlan(state, card.id);
        if (!plan.ok) {
          this.skips.skipped(id, card.id, plan.error);
          continue;
        }
        const check = latestMergeCheck(
          state.events,
          card.id,
          plan.value.completion_id,
        );
        // A1b applies to legacy cards too: advancing main cannot retry a
        // failed current completion. Only explicit recheck/new completion can.
        if (
          check &&
          ["failed", "timed_out"].includes(check.status) &&
          !check.recheck_requested
        )
          continue;
        this.skips.ready(id, card.id);
        const entered = state.events
          .filter(
            (e) =>
              ["review_submitted", "review_reused"].includes(e.type) &&
              (e.payload as { delivery_id?: string } | null)?.delivery_id ===
                plan.value.completion_id,
          )
          .at(-1)?.created_at;
        if (!entered) {
          this.options.onError(new Error("待合并卡片缺少完成审核事件"));
          continue;
        }
        tasks.push({
          project,
          plan: plan.value,
          settings,
          entered,
          priority: card.priority,
        });
      }
    }
    return tasks.sort((a, b) => this.compare(a, b));
  }
  private compare(a: Task, b: Task): number {
    return (
      b.priority - a.priority ||
      a.entered.localeCompare(b.entered) ||
      a.project.project_id.localeCompare(b.project.project_id) ||
      a.plan.card_id.localeCompare(b.plan.card_id)
    );
  }
  /** One project's cards, in order. */
  private async run(tasks: readonly Task[]): Promise<void> {
    // Persist the project's queue before starting its first expensive command.
    await this.serial(async () => {
      for (const task of tasks) {
        if (this.abort.signal.aborted) return;
        try {
          if (this.failedCompletion(task)) continue;
          const prepared = await this.prepare(task);
          if (!this.valid(task)) continue;
          if (prepared.status === "candidate") await this.queue(task, prepared);
          else this.terminal(task, prepared);
        } catch (error) {
          this.failure(task, error);
        }
      }
    });
    const project = tasks[0]?.project.project_id;
    if (!project) return;
    const attempted = new Set<string>();
    // Re-read ranks even while this lane waits for another project's slot.
    const nextTask = () =>
      this.tasks([project]).find((task) => !attempted.has(this.key(task)));
    let pendingSlot: ReturnType<MergeChecks["slot"]> | undefined;
    while (!this.abort.signal.aborted) {
      let task = nextTask();
      if (!task) {
        (await pendingSlot)?.release();
        return;
      }
      try {
        const outage = this.executor(task, "poll");
        if (
          outage &&
          Date.parse(outage.next_retry_at) >
            Date.parse(this.options.clock.now())
        ) {
          (await pendingSlot)?.release();
          return;
        }
        const slot = await (pendingSlot ?? this.slot(task, nextTask));
        pendingSlot = undefined;
        if (!slot) return;
        let ending = false;
        try {
          task = nextTask();
          if (!task) {
            ending = true;
            return;
          }
          const current = task;
          attempted.add(this.key(current));
          // The baseline, rank and executor backoff may have changed while waiting.
          const outage = this.executor(current, "poll");
          if (
            outage &&
            Date.parse(outage.next_retry_at) >
              Date.parse(this.options.clock.now())
          ) {
            ending = true;
            return;
          }
          const check = await this.serial(async () => {
            if (!this.valid(current) || this.failedCompletion(current))
              return undefined;
            const prepared = await this.prepare(current);
            if (prepared.status !== "candidate") {
              this.terminal(current, prepared);
              return undefined;
            }
            return { check: await this.queue(current, prepared) };
          });
          if (!check) continue;
          if (check.check) {
            if (!this.capacity(current)) {
              ending = true;
              return;
            }
            this.active.add(this.key(current));
            try {
              await this.execute(current, check.check, slot.index);
            } finally {
              this.active.delete(this.key(current));
            }
            if (this.executor(current, "poll")) {
              ending = true;
              return;
            }
          }
          await this.serial(() => this.publish(current));
        } finally {
          try {
            const next = !ending && nextTask();
            const outage = next && this.executor(next, "poll");
            // Join the same queue before releasing, so this project's next high
            // tier also competes with other projects already waiting for a slot.
            if (
              next &&
              !this.abort.signal.aborted &&
              this.capacity(next) &&
              (!outage ||
                Date.parse(outage.next_retry_at) <=
                  Date.parse(this.options.clock.now()))
            )
              pendingSlot = this.slot(next, nextTask);
          } finally {
            slot.release();
          }
        }
      } catch (error) {
        if (task) {
          attempted.add(this.key(task));
          this.failure(task, error);
        } else this.report(error);
      }
    }
    (await pendingSlot)?.release();
  }
}
