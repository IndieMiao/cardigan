import { createHash, randomUUID } from "node:crypto";
import type {
  Actor,
  CardId,
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
  batchQueueWait,
  cardTemplate,
  flowAtLeast,
  hasPassedMergeCheck,
  latestMergeCheck,
  type MergeBatch,
  mergeBatches,
  mergePlan,
  passedCardCheck,
  prechecks,
  prepareMergePlan,
  recordMergeBatchCheck,
  recordMergeCheck,
  recordMergeCheckBlockers,
  recordMergeCheckWait,
  recordMergeExecutor,
  recordMergePreparation,
  recordMergeResult,
  validateBatchStartupObservation,
  validateMergeBatchMembers,
} from "@cardigan/domain";
import {
  type CentralProject,
  centralBranch,
  type MergeOutcome,
  type PreparedMerge,
} from "@cardigan/git-service";
import {
  abandonedGithubRequest,
  acquireMergeCheckCapacity,
  CandidateRepositoryBusy,
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
  executionOwner,
  executorExecution,
  GITHUB_POLL_DEFAULTS,
  GithubBranchCleaner,
  GithubBudgetJournal,
  GithubCheckExecutor,
  GithubCheckPoller,
  GithubClient,
  type GithubDispatchIntent,
  GithubDispatchJournal,
  GithubExecutorError,
  type GithubMergeGateExecutor,
  GithubRateLimit,
  GithubRetryLater,
  LOCAL_EXECUTOR,
  type MergeGateConfiguration,
  mergeCheckCapacityAvailable,
  nextMaintenanceRetry,
  type ProjectMergeGate,
  requestChecks,
  runCheckExecutor,
  type runInTemporaryCheckout,
  SshCheckExecutor,
  safeCheckDiagnostic,
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
  type StoreTransactionContext,
} from "@cardigan/store";
import { type AuthorCheckGit, AuthorPrechecks } from "./author-prechecks.js";
import { recordCheckFlakes } from "./check-flake-ledger.js";
import { dispatchStateLoader, type StateLoader } from "./dispatch-state.js";
import {
  CandidatePushNotStarted,
  type MergeGit,
  pushCheckCandidateOrWait,
} from "./git.js";
import { MergeBatches } from "./merge-batches.js";
import {
  MergeStageError,
  mergeFailureReason,
  mergeStage,
} from "./merge-failure.js";
import { mergePublicationGuard } from "./merge-publication.js";
import { mergeProjectSettings } from "./merge-push-loop.js";
import { MergeSkipLog } from "./merge-skip-log.js";
import {
  MergeLockBusy,
  MergeMutex,
  tryPublication,
} from "./publication-lock.js";
import { RepositoryCheckCalls } from "./repository-check-calls.js";
import {
  type RepositoryReceipt,
  type RepositoryTarget,
  repositoryCard,
  repositoryCheckWait,
  repositoryRetryDelays,
} from "./repository-check-wait.js";
import {
  profileProject,
  profileSpan,
  profileSpanSync,
  tickProfiler,
} from "./tick-profile.js";

class StaleCheckTarget extends CheckExecutorSuspended {}
/** C-609: fixed summary when central main moved under a queued or running check. */
export const MERGE_CHECK_BASELINE_MOVED =
  "中心 main 已前进，候选已改变，按新基线重新检查";

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
  /** Offline assembly only: its trusted runner owns exit AND cleanup proof.
   * Await that runner through shutdown; production keeps the normal deadline.
   */
  readonly requireConfirmedExit?: true;
  /** Trusted host provider override; defaults to the existing SSH supervisor. */
  readonly checkExecutor?: CheckExecutor;
  /** Trusted test seam, shared per configured executor. Never an Agent input. */
  readonly githubClient?: (config: GithubMergeGateExecutor) => GithubClient;
  readonly sweep?: typeof sweepCheckoutOrphans;
  readonly recover?: typeof recoverCheckDirectory;
  readonly recoveryInspectionIntervalMs?: number;
  readonly repositoryRetryDelaysMs?: readonly number[];
  /** Total lock wait before host ops is reminded; the check stays queued. */
  readonly repositoryWaitAlertMs?: number;
}
function repositoryWaitReason(timeouts: number, retryAt: string) {
  return `等待仓库空闲（仓库忙，候选尚未分发）；第 ${timeouts} 次等待锁超时，${retryAt} 后重试`;
}

interface Task {
  /** The project's central repository seen through the card's baseline branch. */
  project: CentralProject;
  /** The card's baseline branch cannot be used; preparation records the failure. */
  branchError?: unknown;
  plan: MergePlan;
  settings: Settings;
  entered: string;
  priority: number;
  batch?: MergeBatch;
  repositoryCooling?: boolean;
  /** Admission hint from the task scan, revalidated under the writer lock. */
  publishable?: boolean;
}

function repositoryTarget(task: Task): RepositoryTarget {
  return (
    task.batch ?? {
      project_id: task.project.project_id,
      card_id: task.plan.card_id,
    }
  );
}

/** Persisted queue; the OS execution slot is held by the trusted check supervisor. */
export class MergeChecks {
  private readonly github = new Map<
    string,
    { client: GithubClient; poller: GithubCheckPoller; retryAt: number }
  >();
  private readonly polling = new Set<Promise<void>>();
  private readonly githubCleaners = new Map<string, GithubBranchCleaner>();
  private readonly githubRecoveries = new Map<string, Promise<void>>();
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
  private readonly batches: MergeBatches;
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
   * C-316: one in-flight attempt per card. Only command execution overlaps;
   * Git preparation and publication still use `serial`; state commands
   * commit synchronously in fresh transactions.
   */
  private readonly lanes = new Map<string, Promise<void>>();
  /** Cards whose check is executing outside the mutex. */
  private readonly active = new Set<string>();
  private readonly executions = new Map<
    string,
    { task: Task; abort: AbortController }
  >();
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
  private readonly writers = new Map<string, MergeMutex>();
  private readonly batchAdmissions = new Map<
    ProjectId,
    Promise<{ done: Promise<void> }>
  >();
  private readonly repositoryCalls: RepositoryCheckCalls;
  private readonly lockBackoff: readonly number[];
  private readonly gitPasses = new Map<string, Promise<void>>();
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
    this.repositoryCalls = new RepositoryCheckCalls(
      options.store,
      options.clock,
      options.repositoryWaitAlertMs,
    );
    this.lockBackoff = repositoryRetryDelays(options.repositoryRetryDelaysMs);
    if (options.requireConfirmedExit && (!options.run || options.checkExecutor))
      throw new Error(
        "Confirmed-exit assembly requires a trusted local runner",
      );
    this.batches = new MergeBatches({
      git: options.git,
      state: (id) => this.state(id),
      command: (id, fn) => this.command(id, fn),
      fenced: (id) => this.abort.signal.aborted || this.fenced(id),
    });
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
          push: (input) =>
            pushCheckCandidateOrWait(() =>
              push.call(options.git, project, input),
            ),
          isBaselineAncestor: (sha, branch) =>
            ancestor.call(options.git, project, sha, branch),
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
    while (this.batchAdmissions.size || this.gitPasses.size || this.lanes.size)
      await Promise.all([
        ...this.batchAdmissions.values(),
        ...this.gitPasses.values(),
        ...this.lanes.values(),
      ]);
    await Promise.all([...this.sweeps.values()].map((sweep) => sweep.work));
    await Promise.all(this.githubRecoveries.values());
    await this.prechecks.idle();
    await Promise.all(this.polling);
  }
  private async serial<T>(project: string, work: () => Promise<T>): Promise<T> {
    const writer = this.writers.get(project) ?? new MergeMutex();
    this.writers.set(project, writer);
    try {
      return await writer.run(() => profileProject(project, work));
    } finally {
      if (!writer.busy && this.writers.get(project) === writer)
        this.writers.delete(project);
    }
  }
  private gitPass(key: string, start: () => Promise<void>): Promise<void> {
    const previous = this.gitPasses.get(key);
    if (previous) return previous;
    const work = start()
      .catch((error: unknown) => this.report(error))
      .finally(() => {
        this.gitPasses.delete(key);
      });
    this.gitPasses.set(key, work);
    return work;
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
  private state(project: string, load: StateLoader = loadCommandState) {
    return this.options.store.uow.read((tx) => {
      const state = load(tx, project as ProjectId);
      const settings = mergeProjectSettings(
        this.options.configuration,
        project,
      );
      return settings ? { ...state, project_settings: settings } : state;
    });
  }
  private command<T>(
    project: string,
    reduce: (
      state: CommandState,
      actor: Actor,
      ports: CommandPorts,
    ) => Result<CommandEffect<T>>,
    afterPersist?: (tx: StoreTransactionContext, value: T) => void,
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
      afterPersist?.(tx, result.value.data);
      return result.value.data;
    });
  }
  private check(
    task: Task,
    update: CheckChange,
    requireAdmission = false,
    candidateBinding?: { basis: string; base: string },
  ) {
    const identity = {
      card_id: task.plan.card_id,
      ...(update.status === "interrupted"
        ? { level: update.level }
        : task.settings.queue
          ? { level: task.batch ? ("batch" as const) : ("card" as const) }
          : {}),
      attempt_id: update.attempt_id,
      completion_id: update.completion_id,
      candidate_sha: update.candidate_sha,
      tree_sha: update.tree_sha,
      ...(update.base_sha ? { base_sha: update.base_sha } : {}),
      ...(update.scope ? { scope: update.scope } : {}),
      ...(update.executor ? { executor: update.executor } : {}),
      ...(update.external_run ? { external_run: update.external_run } : {}),
    };
    const recorded = this.command(
      task.project.project_id,
      (s, a, p) => {
        if (
          (requireAdmission || update.status === "queued") &&
          this.fenced(task.project.project_id)
        )
          throw new CheckAdmissionClosed();
        if (candidateBinding) {
          const current = prepareMergePlan(s, task.plan.card_id);
          if (
            !current.ok ||
            JSON.stringify(current.value) !== JSON.stringify(task.plan)
          )
            throw new Error("Merge target changed");
        }
        const change =
          update.status === "queued" || update.status === "running"
            ? { ...identity, status: update.status }
            : { ...update, ...identity };
        const recorded = task.batch
          ? recordMergeBatchCheck(
              s,
              a,
              {
                batch_id: task.batch.id,
                completion_ids: task.batch.members.map((m) => m.completion_id),
                check: change,
              },
              p,
            )
          : recordMergeCheck(s, a, change, p);
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
        return task.batch
          ? recordMergeBatchCheck(
              s,
              a,
              {
                batch_id: task.batch.id,
                completion_ids: task.batch.members.map((m) => m.completion_id),
                check: required,
              },
              p,
            )
          : recordMergeCheck(s, a, required, p);
      },
      candidateBinding
        ? (tx, queued) => {
            tx.events.append(task.project.project_id as ProjectId, {
              id: tx.ids.nextEventId(),
              seq: tx.ids.nextEventSequence(
                task.project.project_id as ProjectId,
                task.plan.card_id,
              ),
              card_id: task.plan.card_id,
              actor: {
                kind: "system",
                project_id: task.project.project_id as ProjectId,
              },
              type: "github_check_candidate",
              payload: {
                attempt: queued.attempt_id,
                sha: queued.candidate_sha,
                tree: queued.tree_sha,
                ...candidateBinding,
              },
              created_at: this.options.clock.now(),
            });
          }
        : undefined,
    );
    if (
      update.executor?.type === "github" &&
      !["queued", "running"].includes(update.status)
    )
      new GithubDispatchJournal(this.options.store).reconcile(
        [task.project.project_id],
        (id) => this.options.configuration.forProject(id),
      );
    return recorded;
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
  private latest(task: Task, tree?: string): MergeCheckView | undefined {
    if (task.batch) {
      const check = mergeBatches(
        this.state(task.project.project_id).events,
      ).find((b) => b.id === task.batch?.id)?.check;
      return !tree || check?.tree_sha === tree ? check : undefined;
    }
    return this.cardCheck(task, tree);
  }
  private cardCheck(task: Task, tree?: string) {
    const { card_id, completion_id } = task.plan;
    return this.options.store.uow.read((tx) =>
      latestMergeCheck(
        tx.events.listAfter(task.project.project_id, card_id, 0),
        card_id,
        completion_id,
        tree,
      ),
    );
  }
  private valid(task: Task, confirmed = false): boolean {
    if (task.batch) {
      const state = this.state(task.project.project_id);
      const current = mergeBatches(state.events).find(
        (b) => b.id === task.batch?.id,
      );
      if (!current || !["checking", "passed"].includes(current.status))
        return false;
      try {
        validateMergeBatchMembers(state, current);
        return true;
      } catch {
        return false;
      }
    }
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
  private validLockObservation(task: Task, check: MergeCheckView) {
    const latest = this.latest(task);
    if (
      latest?.status !== "queued" ||
      latest.attempt_id !== check.attempt_id ||
      latest.recheck_requested
    )
      return false;
    if (!task.batch) return this.valid(task);
    const state = this.state(task.project.project_id);
    const batch = mergeBatches(state.events).find(
      (b) => b.id === task.batch?.id,
    );
    if (batch?.status !== "checking") return false;
    try {
      validateBatchStartupObservation(state, batch);
      return true;
    } catch {
      return false;
    }
  }
  private passed(
    task: Task,
    candidate: Pick<Candidate, "tree_sha" | "previous_sha">,
  ): boolean {
    const events = this.state(task.project.project_id).events;
    const latest = this.latest(task);
    if (task.batch)
      return (
        latest?.status === "passed" &&
        latest.tree_sha === candidate.tree_sha &&
        latest.base_sha === candidate.previous_sha
      );
    if (task.settings.queue)
      return !!passedCardCheck(
        events,
        task.plan.card_id,
        task.plan.completion_id,
      );
    return (
      latest?.base_sha === candidate.previous_sha &&
      hasPassedMergeCheck(
        events,
        task.plan.card_id,
        task.plan.completion_id,
        candidate.tree_sha,
        candidate.previous_sha,
      )
    );
  }
  private async prepare(task: Task): Promise<PreparedMerge> {
    if (task.batch) {
      if (!this.options.git.pinBatch)
        throw new Error("Missing batch candidate pinning");
      await this.options.git.pinBatch(task.project, task.batch);
      return {
        status: "candidate",
        candidate_sha: task.batch.final_sha,
        tree_sha: task.batch.final_tree_sha,
        previous_sha: task.batch.base_sha,
      };
    }
    if (task.branchError)
      throw new MergeStageError("选择基线分支", task.branchError);
    const git = this.git();
    // Background Git can outlive its admission tick, so give it a separate
    // sample rather than appending a duration to a tick that already logged.
    const sync = () => git.sync(task.project);
    await mergeStage(
      "同步源仓库",
      () => tickProfiler()?.tick("merge.git_sync", sync) ?? sync(),
    );
    const baseline = await mergeStage("读取基线", () =>
        git.baseline(task.project),
      ),
      id = `${task.project.project_id}/${task.plan.card_id}`;
    const key = JSON.stringify([task.project, task.plan, baseline]);
    const cached = this.prepared.get(id);
    const value =
      cached?.key === key
        ? cached.value
        : await mergeStage("准备合并候选", () =>
            git.prepare(task.project, task.plan),
          );
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
  /**
   * C-609: a queue-mode card check passes for its completion on any baseline
   * (`passedCardCheck`). A restarted controller re-prepares the candidate on
   * the moved main; the bound GitHub run it already started stays useful, so
   * it is re-attached and read rather than interrupted and run again.
   */
  private resumableCardCheck(task: Task, latest: MergeCheckView): boolean {
    if (
      !task.settings.queue ||
      task.batch ||
      latest.level !== "card" ||
      latest.status !== "running" ||
      latest.recheck_requested ||
      !latest.external_run ||
      this.githubActive.has(latest.attempt_id)
    )
      return false;
    const run = latest.external_run.run_id;
    return new GithubDispatchJournal(this.options.store)
      .unfinished()
      .some(
        (intent) =>
          intent.project === task.project.project_id &&
          intent.card === task.plan.card_id &&
          intent.attempt === latest.attempt_id &&
          intent.executor === task.settings.executor?.name &&
          !intent.abandoned &&
          intent.externalRun?.run_id === run,
      );
  }
  private async interrupt(
    task: Task,
    check: MergeCheckView,
    reason?: "baseline",
  ) {
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
        // C-609: a moved baseline needs a new check whether or not the server
        // restarted; keep it distinguishable from an actual interruption.
        summary:
          reason === "baseline"
            ? MERGE_CHECK_BASELINE_MOVED
            : "检查中断或候选已改变，重新排队",
        log_ref: `${check.attempt_id}.log`,
      },
      true,
    );
    this.seen.delete(check.attempt_id);
  }
  private async queue(
    task: Task,
    input: Pick<Candidate, "candidate_sha" | "tree_sha"> & {
      previous_sha?: string;
      base_sha?: string;
      scope?: MergeCheckView["scope"];
    },
  ): Promise<MergeCheckView | undefined> {
    const candidate = {
      ...input,
      previous_sha: input.previous_sha ?? input.base_sha,
    };
    const { plan } = task;
    const events = this.state(task.project.project_id).events;
    const latest = this.latest(task);
    const basis = createHash("sha256")
      .update(
        JSON.stringify({
          project: task.project,
          plan: task.plan,
          executor: task.settings.executor,
          base: candidate.previous_sha,
          tree: candidate.tree_sha,
        }),
      )
      .digest("hex");
    const binding =
      latest &&
      events.findLast(
        (event) =>
          event.type === "github_check_candidate" &&
          event.actor.kind === "system" &&
          event.actor.project_id === task.project.project_id &&
          event.card_id === plan.card_id &&
          (event.payload as { attempt?: unknown } | null)?.attempt ===
            latest.attempt_id,
      );
    const repositoryWait = repositoryCheckWait(
      events,
      latest,
      repositoryTarget(task),
    );
    const sameCandidate =
      latest &&
      (latest.level ?? "single") ===
        (task.settings.queue ? (task.batch ? "batch" : "card") : "single") &&
      latest.tree_sha === candidate.tree_sha &&
      (latest.base_sha === undefined ||
        latest.base_sha === candidate.previous_sha) &&
      (binding
        ? (latest.candidate_sha === candidate.candidate_sha ||
            new GithubDispatchJournal(
              this.options.store,
            ).crossedDispatchBoundary(
              task.project.project_id,
              plan.card_id,
              latest.attempt_id,
              latest.candidate_sha,
            )) &&
          candidate.previous_sha !== undefined &&
          (binding.payload as { basis?: unknown }).basis === basis &&
          (binding.payload as { sha?: unknown }).sha === latest.candidate_sha
        : latest.candidate_sha === candidate.candidate_sha);
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
        (this.seen.has(latest.attempt_id) ||
          repositoryWait.lastWaitWasLockTimeout) &&
        latest.executor?.name === task.settings.executor?.name &&
        latest.executor?.type ===
          (task.settings.executor
            ? (task.settings.executor.type ?? "ssh")
            : undefined) &&
        latest.status === "queued" &&
        sameCandidate
      ) {
        this.seen.add(latest.attempt_id);
        return latest;
      }
      if (
        task.settings.executor?.type === "github" &&
        latest.executor?.type === "github" &&
        latest.executor.name === task.settings.executor.name &&
        (sameCandidate || this.resumableCardCheck(task, latest))
      )
        return latest;
      await this.interrupt(
        task,
        latest,
        latest.base_sha !== undefined &&
          candidate.previous_sha !== undefined &&
          latest.base_sha !== candidate.previous_sha
          ? "baseline"
          : undefined,
      );
    }
    if (
      this.passed(task, {
        tree_sha: candidate.tree_sha,
        previous_sha: candidate.previous_sha ?? "",
      })
    )
      return undefined;
    const previous = this.latest(task, candidate.tree_sha);
    if (
      previous &&
      (previous.level ?? "single") ===
        (task.settings.queue ? (task.batch ? "batch" : "card") : "single") &&
      !(
        previous.status === "passed" &&
        previous.base_sha !== candidate.previous_sha
      ) &&
      previous.status !== "interrupted" &&
      previous.status !== "executor_unreachable" &&
      !previous.recheck_requested
    )
      return undefined;
    const scope = task.batch
      ? { kind: "full" as const }
      : candidate.previous_sha
        ? await this.scope(
            task,
            candidate.previous_sha,
            candidate.candidate_sha,
          )
        : candidate.scope;
    const queued = this.check(
      task,
      {
        completion_id: plan.completion_id,
        attempt_id: randomUUID(),
        candidate_sha: candidate.candidate_sha,
        tree_sha: candidate.tree_sha,
        ...(candidate.previous_sha ? { base_sha: candidate.previous_sha } : {}),
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
      },
      false,
      task.settings.executor?.type === "github" && candidate.previous_sha
        ? { basis, base: candidate.previous_sha }
        : undefined,
    );
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
    const limit =
      task.settings.executor?.type === "github"
        ? task.settings.executor.maxConcurrent
        : 1;
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
      const waiting = nextTask();
      if (waiting) this.waiting(waiting, "等待检查执行容量");
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
        const check = this.cardCheck(task);
        return (
          !check ||
          check.recheck_requested ||
          ["queued", "interrupted", "executor_unreachable"].includes(
            check.status,
          )
        );
      })
    )
      return;
    const limit = target.type === "github" ? target.maxConcurrent : 1;
    const pool = this.slots.get(target.name);
    if (
      pool?.waiting.length ||
      (pool?.used.filter(Boolean).length ?? 0) >= limit ||
      !mergeCheckCapacityAvailable(this.options.store, target.name, limit)
    )
      return;
    return this.slot({ settings }, () => undefined);
  }
  /** Persist only actual waits; observations never acquire or release capacity. */
  private waiting(task: Task, reason: string, check?: MergeCheckView): false {
    return this.waitingFor(
      task.project.project_id,
      task.plan.card_id,
      task.plan.completion_id,
      reason,
      check ?? (task.batch ? this.latest(task) : undefined),
      task.batch?.id,
    );
  }
  private waitingFor(
    project: string,
    card: CardId,
    completion: DeliveryId,
    reason: string,
    target?: MergeCheckView,
    batch?: MergeBatch["id"],
  ): false {
    this.command(project, (s, a, p) =>
      recordMergeCheckWait(
        s,
        a,
        {
          card_id: card,
          completion_id: completion,
          attempt_id:
            target?.attempt_id ??
            (batch
              ? undefined
              : latestMergeCheck(s.events, card, completion)?.attempt_id) ??
            "",
          reason,
          ...(batch ? { batch_id: batch } : {}),
        },
        p,
      ),
    );
    return false;
  }
  /** The pre-POST writer alone can settle publication. Losing its process identity,
   * or reaching its local supervision deadline, is not permission to take over. */
  private publicationWait(
    task: Task,
    check?: MergeCheckView,
    own?: GithubDispatchIntent,
  ) {
    if (
      own?.phase !== "publishing" ||
      own.externalRun ||
      !check ||
      own.attempt !== check.attempt_id
    )
      return undefined;
    const executor = task.settings.executor;
    if (
      executor?.type === "github" &&
      own.candidate?.repo === executor.repo &&
      own.candidate.sha === check.candidate_sha &&
      own.candidate.delivery === task.plan.completion_id &&
      own.publisher &&
      own.publicationDeadlineAt !== undefined &&
      Date.parse(this.options.clock.now()) < own.publicationDeadlineAt &&
      executionOwner(own.publisher.pid)?.start === own.publisher.start
    )
      return "等待本次候选推送结束";
    // Legacy/missing evidence also stays fenced; repeated observations of the
    // same reason do not append another event or consume another retry.
    return "本地候选发布未结算，待恢复";
  }
  private capacity(task: Task): boolean {
    if (task.repositoryCooling) return false;
    if (this.fenced(task.project.project_id))
      return this.waiting(task, "等待检查移交恢复准入");
    const executor = task.settings.executor;
    if (
      this.options.store.uow.read(() =>
        deploymentInProgress(this.options.store),
      )
    )
      return this.waiting(task, "等待主机部署结束");
    if (executor?.type === "github") {
      if (
        Date.parse(this.options.clock.now()) <
        (this.github.get(executor.name)?.retryAt ?? 0)
      )
        return this.waiting(task, "等待 GitHub API 限额恢复");
      const unfinished = new GithubDispatchJournal(
        this.options.store,
      ).admitted();
      const inFlight = unfinished.filter(
        (intent) => intent.executor === executor.name,
      );
      const latest = this.latest(task);
      // claim() also excludes older work on this card, even on another
      // executor. Queue here instead of repeatedly failing new attempts.
      if (
        unfinished.some(
          (intent) =>
            intent.project === task.project.project_id &&
            intent.card === task.plan.card_id &&
            intent.attempt !== latest?.attempt_id,
        )
      )
        return this.waiting(task, "等待同卡检查释放互斥");
      const own = inFlight.find(
        (intent) =>
          intent.project === task.project.project_id &&
          intent.card === task.plan.card_id &&
          intent.attempt === latest?.attempt_id,
      );
      const publication = this.publicationWait(task, latest, own);
      if (publication) return this.waiting(task, publication, latest);
      if (
        own &&
        Date.parse(this.options.clock.now()) <
          Math.max(
            own.maintenanceRetry?.retryAt ?? 0,
            own.externalRun ? 0 : (own.nextDiscoveryAt ?? 0),
          )
      )
        return this.waiting(task, "等待核对本次 GitHub 派发");
      if (!own && inFlight.length >= executor.maxConcurrent)
        return this.waiting(task, "等待 GitHub 检查容量");
    }
    return (
      !executor ||
      mergeCheckCapacityAvailable(
        this.options.store,
        executor.name,
        executor.type === "github" ? executor.maxConcurrent : 1,
      ) ||
      this.waiting(task, "等待检查执行容量")
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
        ...(config.queueWaitMs ? { queueWaitMs: config.queueWaitMs } : {}),
        ...(config.stepContract ? { stepContract: config.stepContract } : {}),
      });
      shared = { client, poller, retryAt: 0 };
      this.github.set(config.name, shared);
    }
    return shared;
  }
  private githubMaintenanceConfig(intent: GithubDispatchIntent) {
    const settings = this.options.configuration.forProject(intent.project);
    if (settings.status === "invalid" || !intent.executor) return undefined;
    const config =
      settings.status === "enabled" &&
      settings.executor?.name === intent.executor
        ? settings.executor
        : this.options.configuration.forExecutor?.(intent.executor);
    if (
      config?.type !== "github" ||
      (intent.candidate && intent.candidate.repo !== config.repo) ||
      (intent.identity &&
        (intent.identity.actor.login !== config.botLogin ||
          ![
            config.workflow,
            `${config.workflow}@${intent.identity.head_branch}`,
          ].includes(intent.identity.path) ||
          intent.identity.html_url !==
            `https://github.com/${config.repo}/actions/runs/${intent.identity.id}`))
    )
      return undefined;
    return config;
  }
  private githubExecutor(
    task: Task,
    check: MergeCheckView,
    config: GithubMergeGateExecutor,
    bind: (run: ExternalGithubRun) => void,
    publish: typeof pushCheckCandidateOrWait,
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
        publish(() =>
          pushCheckCandidate.call(this.options.git, task.project, input),
        ),
      isBaselineAncestor: (sha, branch) =>
        isBaselineAncestor.call(this.options.git, task.project, sha, branch),
    });
  }
  private recoverAbandonedGithub(
    intent: GithubDispatchIntent,
    journal: GithubDispatchJournal,
  ): void {
    const id = `${intent.project}/${intent.card}/${intent.attempt}`;
    const now = () => Date.parse(this.options.clock.now());
    if (
      now() <
      Math.max(
        intent.nextDiscoveryAt ?? 0,
        intent.maintenanceRetry?.retryAt ?? 0,
      )
    )
      return;
    if (
      this.githubRecoveries.has(id) ||
      !intent.abandoned ||
      intent.phase !== "dispatching" ||
      intent.externalRun
    )
      return;
    const config = this.githubMaintenanceConfig(intent);
    const project = this.options.git.projectOf(intent.project as ProjectId);
    const settings = this.options.configuration.forProject(intent.project);
    const request = abandonedGithubRequest(
      this.options.store,
      journal,
      intent,
      settings,
    );
    const ancestor = this.options.git.isBaselineAncestor;
    if (!config || !project || !request || !ancestor) return;
    const card = this.state(intent.project).cards.find(
      (c) => c.id === intent.card,
    );
    const view = branchView(
      project,
      card?.base_branch ? { base_branch: card.base_branch } : undefined,
    ).project;
    const { client, poller } = this.githubProvider(config);
    const executor = new GithubCheckExecutor({
      config,
      client,
      journal,
      lifecycle: poller,
      now: () => Date.parse(this.options.clock.now()),
      context: () => ({
        card: intent.card,
        delivery: request.delivery,
        baselineBranch: view.base_branch,
      }),
      push: async () => {
        throw new Error("Recovery cannot publish candidates");
      },
      isBaselineAncestor: (sha, branch) =>
        ancestor.call(this.options.git, view, sha, branch),
    });
    const work = executor
      .recoverAbandoned(
        {
          ...request.check,
          signal: this.abort.signal,
        },
        intent,
      )
      .then(
        () => {},
        (error) => {
          if (this.abort.signal.aborted) return;
          const at = now();
          const expired =
            at >=
            (intent.discoveryDeadlineAt ??
              Date.parse(intent.startedAt) +
                (config.waitStartMs ?? GITHUB_POLL_DEFAULTS.waitStartMs));
          const retry = nextMaintenanceRetry(
            intent.maintenanceRetry,
            at,
            config.pollIntervalMs ?? GITHUB_POLL_DEFAULTS.pollIntervalMs,
            expired ? "discovery_expired" : "discovery_error",
            error instanceof GithubRetryLater ? error.retryAt : 0,
          );
          journal.retryBinding(intent).save(retry);
          if (error instanceof GithubRetryLater && !expired) return;
          const cause =
            error instanceof GithubExecutorError
              ? `${error.category}: ${error.diagnostic ?? error.message}`
              : error;
          const detail = safeCheckDiagnostic(
            cause,
            settings.status === "enabled" ? settings.env : {},
          );
          this.report(
            new Error(
              `旧 GitHub 派发身份尚未确认，保留占用 project=${intent.project} card=${intent.card} attempt=${intent.attempt}${expired ? " 发现期限已过，无法确认" : ""} retryAt=${new Date(retry.retryAt).toISOString()}: ${detail}`,
            ),
          );
        },
      )
      .catch((error: unknown) => this.report(error))
      .finally(() => {
        this.githubRecoveries.delete(id);
      });
    this.githubRecoveries.set(id, work);
  }
  private held(task: Task, check?: MergeCheckView) {
    if (check?.status === "running" || check?.external_run) return false;
    if (
      !this.state(task.project.project_id).cards.find(
        (c) => c.id === task.plan.card_id,
      )?.hold
    )
      return false;
    return (
      !check ||
      !new GithubDispatchJournal(this.options.store)
        .unfinished()
        .some(
          (i) =>
            i.project === task.project.project_id &&
            i.attempt === check.attempt_id &&
            i.phase === "dispatching",
        )
    );
  }
  private async execute(
    task: Task,
    check: MergeCheckView,
    slot: number,
  ): Promise<void> {
    if (this.held(task, check)) {
      this.waiting(task, "卡片已暂停，等待恢复检查");
      return;
    }
    let log: Awaited<ReturnType<typeof createMergeCheckLog>> | undefined;
    let result: Awaited<ReturnType<typeof runInTemporaryCheckout>>;
    let releaseCapacity: ReturnType<typeof acquireMergeCheckCapacity>;
    let connected = false;
    let callId: string | undefined;
    let receipt: RepositoryReceipt | undefined;
    const settle = (id: string, outcome: RepositoryReceipt["outcome"]) =>
      this.repositoryCalls.settle(
        task.project.project_id,
        task.plan.card_id,
        id,
        outcome,
      );
    const publish: typeof pushCheckCandidateOrWait = async (push) => {
      // The writer, not its detachable supervisor, owns this call until the
      // actual adapter settles. Persist the fact BEFORE releasing its fence.
      const id = callId;
      if (!id) throw new CheckExecutorSuspended();
      callId = undefined;
      let outcome: RepositoryReceipt["outcome"] = "other";
      try {
        const result = await pushCheckCandidateOrWait(push);
        if (result.status === "not_started") outcome = "timeout";
        return result;
      } finally {
        receipt = settle(id, outcome);
        // Detachment may have already closed execute(). Keep the attempt log
        // aligned with the durable receipt while this publisher still owns it.
        if (receipt.outcome === "timeout" && receipt.retry_at) {
          await log
            ?.waiting(repositoryWaitReason(receipt.ordinal, receipt.retry_at))
            .catch((error: unknown) => this.report(error));
        }
      }
    };
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
      this.waiting(
        task,
        error instanceof DeploymentInProgress
          ? "等待主机部署结束"
          : "等待检查移交恢复准入",
      );
      return; // Keep the check queued; deployment does not change its result.
    }
    const cancel = new AbortController();
    this.executions.set(this.key(task), { task, abort: cancel });
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
        // Resume the same trusted attempt after a hold during distribution.
        resume: true,
        ...(executedOn?.infraFlakyRules
          ? { infraFlakyRules: executedOn.infraFlakyRules }
          : {}),
        workerIdentity,
        ...(workerContext ? { workerContext } : {}),
        ...(executedOn?.type === "github"
          ? {
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
      if (this.options.requireConfirmedExit && executedOn?.type === "github")
        throw new Error(
          "Confirmed-exit assembly cannot dispatch GitHub checks",
        );
      const executor =
        (executedOn?.type === "github"
          ? this.githubExecutor(
              task,
              check,
              executedOn,
              (run) => {
                bound = run;
              },
              publish,
            )
          : this.options.checkExecutor) ??
        new SshCheckExecutor({
          execution,
          distribute: () =>
            this.serial(task.project.project_id, async () => {
              try {
                await this.git().distribute(task.project, execution);
              } catch (error) {
                if (error instanceof CandidatePushNotStarted)
                  throw new CandidateRepositoryBusy();
                throw error;
              }
              connected = true;
            }),
          ...(this.options.run ? { run: this.options.run } : {}),
        });
      // Shutdown during dispatch still waits for this offline run's cleanup.
      // SshCheckExecutor already forwards the abort signal to its trusted run.
      const execute: typeof runCheckExecutor = this.options.requireConfirmedExit
        ? async (provider, request) =>
            provider.poll(await provider.dispatch(request))
        : runCheckExecutor;
      if (this.held(task, check)) return;
      if (
        check.status === "queued" &&
        !bound &&
        !(
          executedOn?.type === "github" &&
          new GithubDispatchJournal(this.options.store).crossedDispatchBoundary(
            task.project.project_id,
            task.plan.card_id,
            check.attempt_id,
            check.candidate_sha,
          )
        )
      ) {
        const admission = this.repositoryCalls.begin(
          repositoryTarget(task),
          check,
          this.lockBackoff,
        );
        if (admission.kind === "wait") return;
        callId = admission.id;
      }
      this.waiting(
        task,
        executedOn?.type === "github"
          ? "等待 GitHub 启动并绑定检查运行"
          : "等待检查执行器启动",
      );
      result = await execute(
        executor,
        {
          beforeDispatch: async () => {
            // Distribution can wait on its very first push. Check the target at
            // worker start / first POST, independently of retry accounting.
            if (
              check.base_sha &&
              (await this.git().baseline(task.project)) !== check.base_sha
            )
              throw new StaleCheckTarget();
            const latest = this.latest(task);
            if (
              !this.valid(task) ||
              latest?.status !== "queued" ||
              latest.recheck_requested ||
              latest.attempt_id !== check.attempt_id ||
              latest.candidate_sha !== check.candidate_sha
            )
              throw new StaleCheckTarget();
            if (this.abort.signal.aborted || this.held(task, check))
              throw new CheckExecutorSuspended();
          },
          kind: "merge_check",
          ...(task.settings.queue
            ? { mergeTier: task.batch ? ("batch" as const) : ("card" as const) }
            : {}),
          project: task.project.project_id,
          attempt: check.attempt_id,
          sha: check.candidate_sha,
          tree: check.tree_sha,
          checks: requestChecks(
            task.settings,
            check.scope,
            task.batch ? "batch" : "card",
          ),
          env: task.settings.env,
          totalTimeoutMs: task.settings.totalTimeoutMs,
          serialize: true,
          lockSlot: slot,
          ...(executedOn?.type === "github"
            ? { hostSignal: this.abort.signal, signal: cancel.signal }
            : { signal: AbortSignal.any([this.abort.signal, cancel.signal]) }),
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
            if (executedOn?.type !== "github") releaseCapacity.transfer(owner);
            this.executor(task, "reachable");
            this.check(task, {
              ...check,
              ...(bound ? { external_run: bound } : {}),
              status: "running",
            });
            // The durable GitHub journal owns remote capacity, not this host lock.
            if (executedOn?.type === "github") releaseCapacity();
          },
          onProgress: (summary) => {
            if (this.valid(task))
              new GithubDispatchJournal(this.options.store).progress(
                task.project.project_id as ProjectId,
                task.plan.card_id,
                check.attempt_id,
                summary,
                this.options.clock.now(),
              );
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
          resetFailureLog: (name) => log?.resetOutput(name),
          onOutput: (name, text) => log?.append(name, text),
        },
        (error) => this.report(error),
      );
    } catch (error) {
      // No worker started when the SSH distributor could not acquire the Git
      // lock. Leave this attempt queued; contention is not an executor failure.
      if (error instanceof MergeLockBusy) throw error;
      if (error instanceof StaleCheckTarget) return;
      if (error instanceof CandidateRepositoryBusy) {
        // A non-GitHub executor returns its proof to the supervisor directly.
        if (callId) {
          receipt = settle(callId, "timeout");
          callId = undefined;
        }
        // Lock contention is not a check result: the attempt stays queued and
        // retries with backoff; only an overdue wait reminds host ops.
        if (receipt?.outcome !== "timeout" || !receipt.retry_at)
          throw new Error("Missing repository timeout receipt");
        const reason = repositoryWaitReason(receipt.ordinal, receipt.retry_at);
        if (this.validLockObservation(task, check))
          this.waiting(task, reason, check);
        if (executedOn?.type !== "github") await log?.waiting(reason);
        return;
      } else if (error instanceof CheckExecutorSuspended) {
        if (this.abort.signal.aborted) return;
        this.waiting(task, "卡片已暂停，等待恢复检查");
        return;
      } else {
        if (executedOn?.type === "github") {
          if (error instanceof GithubRetryLater) {
            if (error.scope === "attempt") {
              this.waiting(task, "等待核对本次 GitHub 派发");
              return;
            }
            this.waiting(task, "等待 GitHub API 限额恢复");
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
      }
    } finally {
      // Always release runtime occupancy, even if a returned/cancelled target
      // makes the subsequent business result command reject.
      try {
        if (callId) {
          settle(callId, "other");
          callId = undefined;
        }
      } finally {
        releaseCapacity();
        this.executions.delete(this.key(task));
      }
    }
    // A watchdog may return while its Git call still owns the writer fence.
    // Do not turn that local observation into a terminal check or project outage.
    if (
      executedOn?.type === "github" &&
      !bound &&
      result.status === "executor_unreachable"
    ) {
      const own = new GithubDispatchJournal(this.options.store)
        .unfinished()
        .find(
          (i) =>
            i.executor === executedOn.name &&
            i.project === task.project.project_id &&
            i.card === task.plan.card_id &&
            i.attempt === check.attempt_id,
        );
      const publication = this.publicationWait(task, check, own);
      if (publication) {
        this.waiting(task, publication, check);
        return; // The unsettled writer still owns its receipt and log.
      }
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
    const cardBusy =
      executedOn?.type === "github" &&
      !bound &&
      result.status === "executor_unreachable" &&
      result.reason === "检查执行器不可用：card_busy";
    if (
      result.status === "executor_unreachable" &&
      (executedOn?.type !== "github" || bound || transientDiscovery)
    )
      this.executor(task, "unreachable", check.attempt_id);
    else if (!cardBusy && connected && !this.abort.signal.aborted)
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
        ? await log.finish(
            result,
            executedOn?.type === "github" ? bound : undefined,
            bound
              ? recordCheckFlakes(
                  this.options.store,
                  task.project.project_id as ProjectId,
                  task.plan.card_id,
                  check.attempt_id,
                  this.options.clock.now(),
                  result.recovered,
                )
              : undefined,
          )
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
    if ((executedOn?.type === "github" || task.batch) && !this.valid(task)) {
      this.githubActive.delete(check.attempt_id);
      this.seen.delete(check.attempt_id);
      return;
    }
    if (cardBusy) {
      this.waiting(task, "等待同卡检查释放互斥");
      // A competing controller won admission after our capacity check. No
      // workflow was started: keep this queued identity for a later pass.
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
      this.waiting(task, "等待 GitHub 确认此前派发的运行");
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
    const latest = this.latest(task);
    return (
      !!latest &&
      ["failed", "timed_out"].includes(latest.status) &&
      !latest.recheck_requested
    );
  }
  private async publish(task: Task) {
    if (task.settings.queue || task.batch) return;
    if (this.failedCompletion(task)) return;
    if (this.fenced(task.project.project_id)) return;
    if (this.abort.signal.aborted || !this.valid(task, true)) return;
    const candidate = await this.prepare(task);
    if (candidate.status !== "candidate") {
      this.terminal(task, candidate);
      return;
    }
    if (
      !this.passed(task, {
        tree_sha: candidate.tree_sha,
        previous_sha: candidate.previous_sha ?? "",
      })
    ) {
      await this.queue(task, candidate);
      return;
    }
    await this.release(task, candidate);
  }
  /** Publish only a confirmed candidate whose exact tree already passed. */
  private async ready(task: Task) {
    if (task.settings.queue || task.batch) return;
    if (this.fenced(task.project.project_id)) return;
    if (this.abort.signal.aborted || !this.valid(task, true)) return;
    const latest = this.latest(task);
    if (latest?.status !== "passed") return;
    const candidate = await this.prepare(task);
    if (
      candidate.status === "candidate" &&
      this.passed(task, {
        tree_sha: candidate.tree_sha,
        previous_sha: candidate.previous_sha ?? "",
      })
    )
      await this.release(task, candidate);
  }
  private async release(task: Task, candidate: Candidate) {
    if (this.fenced(task.project.project_id)) return;
    // Re-read confirmation/state after Git IO. CAS protects against another baseline writer.
    if (!this.valid(task, true)) return;
    // C-94: moving central main and recording the move share one lock with
    // the pre-push check, so an unrecorded window is never observed.
    await tryPublication(task.project.project_id, async () => {
      if (this.fenced(task.project.project_id)) return;
      if (this.abort.signal.aborted || !this.valid(task, true)) return;
      const git = this.git();
      await mergeStage("发布合并", () =>
        git.publish(
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
        ),
      );
    });
  }
  private failure(task: Task, error: unknown) {
    if (error instanceof CheckAdmissionClosed) return;
    this.report(error);
    if (error instanceof MergeLockBusy) return;
    if (!this.valid(task) || task.batch) return;
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
        reason: mergeFailureReason(task.plan.card_id, error, "检查或结果记录"),
      });
  }
  /** Awaits the check round this call started, or only the publish pass. */
  async tick(projects: readonly ProjectId[]): Promise<void> {
    await (await this.schedule(projects)).done;
  }
  /**
   * Each pass independently publishes confirmed candidates whose tree passed,
   * including projects waiting in executor backoff or running another check
   * (C-113). Idle cards then start checks in the background; unchecked
   * candidates use live priority, FIFO ties and the executor's retry deadline.
   */
  async schedule(
    projects: readonly ProjectId[],
  ): Promise<{ readonly done: Promise<void> }> {
    if (this.abort.signal.aborted) return { done: Promise.resolve() };
    const batching = new Set<ProjectId>();
    const batchPasses: Promise<void>[] = [];
    for (const id of projects) {
      const settings = this.options.configuration.forProject(id);
      if (
        settings.status !== "enabled" ||
        (!settings.queue &&
          !this.state(id).events.some(
            (e) => e.type === "merge_queue_configured" && e.payload,
          ))
      )
        continue;
      const project = this.options.git.projectOf(id);
      if (!project) continue;
      batching.add(id);
      // Admit once after the queue view is current. Do not keep the batch
      // writer occupied while checks wait for a later poll or queue pass.
      let admission = this.batchAdmissions.get(id);
      if (!admission) {
        admission = this.serial(id, () => this.batches.tick(project, settings))
          .catch((error: unknown) => this.report(error))
          .then(() => ({ done: this.startCards([id]) }))
          .finally(() => {
            this.batchAdmissions.delete(id);
          });
        this.batchAdmissions.set(id, admission);
      }
      batchPasses.push(admission.then(({ done }) => done));
    }
    for (const execution of this.executions.values())
      if (!this.valid(execution.task)) execution.abort.abort();
    const journal = new GithubDispatchJournal(this.options.store);
    const unfinished = profileSpanSync("merge.journal", () => {
      journal.reconcile(projects, (project) =>
        this.options.configuration.forProject(project),
      );
      return journal.unfinished();
    });
    const journalState = dispatchStateLoader(this.options.store);
    for (const intent of unfinished) {
      if (
        projects.includes(intent.project as ProjectId) &&
        !this.fenced(intent.project)
      )
        this.recoverAbandonedGithub(intent, journal);
      if (
        !projects.includes(intent.project as ProjectId) ||
        !intent.externalRun ||
        !intent.identity
      )
        continue;
      const settings = this.options.configuration.forProject(intent.project);
      const config = this.githubMaintenanceConfig(intent);
      if (!config) continue;
      const state = this.state(intent.project, journalState);
      if (intent.identity.display_title.split("/")[4] === "precheck") {
        const author = prechecks(state.events).find(
          (c) => c.attempt_id === intent.attempt,
        );
        if (author && ["queued", "running"].includes(author.status)) continue;
      }
      const batch = mergeBatches(state.events).find(
        (b) => b.check?.attempt_id === intent.attempt,
      );
      if (
        batch?.status === "checking" &&
        batch.check &&
        ["queued", "running"].includes(batch.check.status)
      )
        continue;
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
        !intent.abandoned &&
        plan.ok &&
        plan.value.completion_id === delivery &&
        card?.status === "awaiting_merge" &&
        latest?.attempt_id === intent.attempt &&
        ["queued", "running"].includes(latest.status)
      )
        continue;
      const { poller } = this.githubProvider(config);
      try {
        poller.register(
          intent.externalRun,
          {
            project: intent.project,
            kind: "merge_check",
            sha: "0".repeat(40),
            tree: "0".repeat(40),
            checks: settings.status === "enabled" ? settings.checks : [],
          },
          intent.identity,
          () => journal.finish(intent),
          intent.boundByDispatchId === true,
          journal.retryBinding(intent),
        );
      } catch (error) {
        this.report(error);
        continue; // A conflicting journal binding is never cancelled or released.
      }
      void poller.cancel(intent.externalRun).catch(() => {});
    }
    // Same trusted scheduling boundary drives all remote lifecycle work.
    for (const state of this.githubActive.values()) {
      if (!this.valid(state.task))
        void state.poller.cancel(state.run).catch(() => {});
    }
    // A slow provider must not sit between *all* cards and admission. Pollers
    // coalesce overlapping ticks. Join this maintenance via done/idle, not schedule.
    const polling = [...this.github.values()].map(async ({ poller }) => {
      try {
        await poller.tick();
      } catch (error) {
        this.report(error);
      }
    });
    const maintenance = Promise.all(polling)
      .then(() => {
        if (!this.abort.signal.aborted)
          return this.cleanGithubCandidates(projects, journal);
      })
      .catch((error: unknown) => this.report(error));
    this.polling.add(maintenance);
    void maintenance.finally(() => this.polling.delete(maintenance));
    try {
      this.sweep(projects);
    } catch (error) {
      this.report(error);
    }
    const cards = this.startCards(projects.filter((id) => !batching.has(id)));
    const author = await profileSpan("merge.prechecks", () =>
      this.prechecks.schedule(projects),
    );
    return {
      done: Promise.all([
        cards,
        ...batchPasses,
        maintenance,
        ...this.githubRecoveries.values(),
        author.done,
      ]).then(() => {}),
    };
  }
  private async startCards(projects: readonly ProjectId[]): Promise<void> {
    if (this.abort.signal.aborted || !projects.length) return;
    let tasks: Task[];
    try {
      tasks = profileSpanSync("merge.tasks", () => this.tasks(projects));
    } catch (error) {
      this.report(error);
      return;
    }
    const started: Promise<void>[] = [];
    for (const task of tasks) {
      const key = this.key(task);
      if (!task.publishable || this.active.has(key)) continue;
      started.push(
        this.gitPass(`ready/${key}`, () =>
          this.serial(task.project.project_id, async () => {
            if (!this.abort.signal.aborted && !this.active.has(key))
              await this.ready(task);
          }).catch((error: unknown) => {
            this.failure(task, error);
          }),
        ),
      );
    }
    const fresh: Task[] = [];
    for (const task of tasks) {
      if (
        task.repositoryCooling ||
        this.lanes.has(this.key(task)) ||
        !this.valid(task)
      )
        continue;
      fresh.push(task);
    }
    const live = new Set(tasks.map((t) => this.key(t)));
    for (const key of this.prepared.keys()) {
      const project = key.slice(0, key.indexOf("/"));
      if (
        projects.includes(project as ProjectId) &&
        !this.lanes.has(key) &&
        !live.has(key)
      )
        this.prepared.delete(key);
    }
    for (const task of fresh) {
      const id = this.key(task);
      // Nobody may await a background lane: it must never reject, even when
      // the error reporter itself throws.
      const lane = this.run(task)
        .catch((error: unknown) => {
          try {
            this.failure(task, error);
          } catch (failure) {
            this.report(failure);
          }
        })
        .finally(() => {
          if (this.lanes.get(id) === lane) this.lanes.delete(id);
        });
      this.lanes.set(id, lane);
      started.push(lane);
    }
    await Promise.all(started);
  }
  private async cleanGithubCandidates(
    projects: readonly ProjectId[],
    journal: GithubDispatchJournal,
  ): Promise<void> {
    const work: Promise<void>[] = [];
    // Cleanup is diagnostic-only and follows the D4 maintenance cadence.
    const cleanupTargets = new Map<
      string,
      { config: GithubMergeGateExecutor; projects: Set<string> }
    >();
    for (const intent of journal.all()) {
      if (
        !projects.includes(intent.project as ProjectId) ||
        !intent.finished ||
        intent.deleted ||
        !this.options.git.deleteCheckCandidate
      )
        continue;
      const config = this.githubMaintenanceConfig(intent);
      if (!config) continue;
      const key = JSON.stringify(config);
      const target = cleanupTargets.get(key) ?? {
        config,
        projects: new Set<string>(),
      };
      target.projects.add(intent.project);
      cleanupTargets.set(key, target);
    }
    for (const {
      config,
      projects: eligibleProjects,
    } of cleanupTargets.values()) {
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
      work.push(
        cleaner
          .tick([...eligibleProjects])
          .catch((error: unknown) => this.report(error)),
      );
    }
    await Promise.all(work);
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
    return `${task.project.project_id}/${task.batch?.id ?? task.plan.card_id}`;
  }
  private tasks(projects: readonly ProjectId[]): Task[] {
    const tasks: Task[] = [];
    for (const id of projects) {
      if (this.fenced(id)) {
        // A fenced project never reaches capacity()/execute(). Observe its
        // existing queue without preparing candidates or admitting any work.
        const state = this.state(id);
        const awaiting = new Set(
          state.cards
            .filter((c) => c.status === "awaiting_merge")
            .map((c) => c.id),
        );
        const items = new Map(state.work_items.map((w) => [w.id, w.card_id]));
        for (const completion of state.deliveries) {
          const card = items.get(completion.work_item_id);
          if (
            completion.kind !== "card_completion" ||
            completion.status !== "accepted" ||
            !card ||
            !awaiting.has(card)
          )
            continue;
          this.waitingFor(id, card, completion.id, "等待检查移交恢复准入");
        }
        continue;
      }
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
      const observeCooldown = (
        check: MergeCheckView | undefined,
        target: RepositoryTarget,
      ) => {
        const { retryAt, timeouts } = repositoryCheckWait(
          state.events,
          check,
          target,
        );
        const batch = "members" in target ? target : undefined;
        const cooling =
          retryAt !== undefined &&
          Date.parse(this.options.clock.now()) < Date.parse(retryAt);
        const card = repositoryCard(target);
        if (cooling && card && check) {
          const reason = repositoryWaitReason(timeouts, retryAt);
          // A regrouped attempt can inherit a deadline without making a call.
          // Report the existing wait; do not charge another repository timeout.
          const wait = batch
            ? batchQueueWait(state.events, batch)
            : check.queue_wait;
          if (wait?.reason !== reason)
            this.waitingFor(
              id,
              card,
              check.completion_id,
              reason,
              check,
              batch?.id,
            );
        }
        return cooling;
      };
      if (settings.queue) {
        for (const batch of mergeBatches(state.events).filter(
          (b) => b.status === "checking",
        )) {
          const last = batch.members.at(-1);
          const plan = last && mergePlan(state, last.card_id);
          if (plan?.ok)
            tasks.push({
              ...branchView(project, plan.value),
              plan: plan.value,
              settings,
              batch,
              repositoryCooling: observeCooldown(batch.check, batch),
              entered: batch.formed_at,
              priority: batch.priority,
            });
        }
      }
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
        if (
          settings.queue &&
          passedCardCheck(state.events, card.id, plan.value.completion_id)
        )
          continue;
        const check = latestMergeCheck(
          state.events,
          card.id,
          plan.value.completion_id,
        );
        if (
          card.hold &&
          check?.status !== "running" &&
          !check?.external_run &&
          !new GithubDispatchJournal(this.options.store)
            .unfinished()
            .some(
              (i) =>
                i.project === id &&
                i.card === card.id &&
                i.attempt === check?.attempt_id &&
                i.phase === "dispatching",
            )
        ) {
          this.waitingFor(
            id,
            card.id,
            plan.value.completion_id,
            "卡片已暂停，等待恢复检查",
          );
          continue;
        }
        // A1b applies to legacy cards too: advancing main cannot retry a
        // failed current completion. Only explicit recheck/new completion can.
        if (
          check &&
          ["failed", "timed_out"].includes(check.status) &&
          !check.recheck_requested
        )
          continue;
        this.skips.ready(id, card.id);
        const completion = state.deliveries.find(
          (v) => v.id === plan.value.completion_id,
        );
        const template = cardTemplate(card, state.card_templates);
        // A validated system completion without an acceptance work item enters
        // the queue when submitted. No synthetic Review is needed or created.
        const systemCompleted =
          flowAtLeast(card, 5) &&
          completion?.status === "accepted" &&
          !!completion.system_completion &&
          completion.requested_verifiers.length === 0 &&
          template?.completion.mode === "review" &&
          template.completion.reviewer === "system";
        const entered = state.events
          .filter(
            (e) =>
              e.card_id === card.id &&
              (["review_submitted", "review_reused"].includes(e.type) ||
                (systemCompleted &&
                  e.type === "delivery_submitted" &&
                  e.actor.kind === "system")) &&
              (e.payload as { delivery_id?: string } | null)?.delivery_id ===
                plan.value.completion_id,
          )
          .at(-1)?.created_at;
        if (!entered) {
          this.options.onError(
            new Error("待合并卡片缺少完成审核或系统完成事件"),
          );
          continue;
        }
        tasks.push({
          ...branchView(project, plan.value),
          plan: plan.value,
          settings,
          entered,
          repositoryCooling: observeCooldown(check, {
            project_id: id,
            card_id: card.id,
          }),
          publishable: !settings.queue && check?.status === "passed",
          priority: card.priority,
        });
      }
    }
    return tasks.sort((a, b) => this.compare(a, b));
  }
  private compare(a: Task, b: Task): number {
    return (
      b.priority - a.priority ||
      Number(!!b.batch) - Number(!!a.batch) ||
      a.entered.localeCompare(b.entered) ||
      a.project.project_id.localeCompare(b.project.project_id) ||
      a.plan.card_id.localeCompare(b.plan.card_id)
    );
  }
  /** One card competes in the target pool using its current priority. */
  private async run(task: Task): Promise<void> {
    const nextTask = () =>
      this.tasks([task.project.project_id]).find(
        (current) =>
          this.key(current) === this.key(task) &&
          JSON.stringify(current.plan) === JSON.stringify(task.plan),
      );
    // Persist queued before waiting for capacity; preparation never overlaps Git.
    await this.serial(task.project.project_id, async () => {
      if (this.abort.signal.aborted || !this.valid(task)) return;
      const prepared = await this.prepare(task);
      if (!this.valid(task)) return;
      if (this.held(task)) return;
      if (prepared.status === "candidate") await this.queue(task, prepared);
      else this.terminal(task, prepared);
    });
    const outage = this.executor(task, "poll");
    if (
      this.abort.signal.aborted ||
      !this.valid(task) ||
      (outage &&
        Date.parse(outage.next_retry_at) > Date.parse(this.options.clock.now()))
    )
      return;
    const slot = await this.slot(task, nextTask);
    if (!slot) return;
    try {
      const current = nextTask();
      if (!current || this.abort.signal.aborted) return;
      const outage = this.executor(current, "poll");
      if (
        outage &&
        Date.parse(outage.next_retry_at) > Date.parse(this.options.clock.now())
      )
        return;
      // A slot wait may outlive a baseline change, cancellation or confirmation.
      const check = await this.serial(current.project.project_id, async () => {
        if (!this.valid(current) || this.failedCompletion(current))
          return undefined;
        const prepared = await this.prepare(current);
        if (!this.valid(current)) return undefined;
        if (prepared.status !== "candidate") {
          this.terminal(current, prepared);
          return undefined;
        }
        return { check: await this.queue(current, prepared) };
      });
      if (!check) return;
      if (check.check) {
        if (!this.capacity(current)) return;
        this.active.add(this.key(current));
        try {
          await this.execute(current, check.check, slot.index);
        } finally {
          this.active.delete(this.key(current));
        }
        if (this.executor(current, "poll")) return;
      }
      await this.serial(current.project.project_id, () =>
        this.publish(current),
      );
    } finally {
      slot.release();
    }
  }
}

/** The card's branch view of the central repository; an unusable name fails at preparation. */
function branchView(
  project: CentralProject,
  plan: Pick<MergePlan, "base_branch"> | undefined,
): Pick<Task, "project" | "branchError"> {
  if (!plan) return { project };
  try {
    return { project: centralBranch(project, plan.base_branch) };
  } catch (error) {
    return { project, branchError: error };
  }
}
