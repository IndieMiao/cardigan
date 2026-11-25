import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
  Assignment,
  Delivery,
  DeliveryId,
  DeliverySubject,
  DeliveryVerifier,
  GitPublicationGuard,
  GitRef,
  MergeBatch,
  MergePlan,
  MergePushCommit,
  ProjectId,
  SystemReviewLimitCandidate,
  SystemReviewLimitFailure,
  SystemReviewLimitOutcome,
} from "@cardigan/domain";
import { CheckHeadFailure, validationFailed } from "@cardigan/domain";
import {
  type CentralProject,
  CentralRepositoryService,
  GitDeliveryVerifier,
  GitWorktreeService,
  type MergeOutcome,
  type PreparedMerge,
  type ReconcileChecks,
  type ReconcileFinding,
  type RemoveBuildOutcome,
  type RemoveWorktreeInput,
  type RemoveWorktreeOutcome,
  type RepositoryLock,
  type RepositoryLockSample,
  RepositoryLockTimeoutError,
  reconcile,
  reconcileExecutorChecks,
  type SourceSync,
  type StagedDeliverySource,
  validCentralBranch,
  type WorktreeDiff,
} from "@cardigan/git-service";
import {
  type CandidateDeleteRequest,
  type CandidatePushRequest,
  CentralGitTransport,
  type CentralRepackMode,
  LocalGitTransport,
  type PushResult,
  type WorkspaceGit as WorkspaceGitPort,
  withGitTimeout,
} from "@cardigan/git-transport";
import {
  acquireRepositoryFlock,
  type CandidateTestSnapshot,
  candidateTestPath,
  HostTestReviewTrust,
  hostRepositoryLock,
  loadWorkspace,
  type MergePushConfig,
  PreparationQueueTimeout,
  pinStallBackup,
  preparationBusy,
  preparationRevision,
  proveSystemReviewLimit,
  RuntimeTargetError,
  type RuntimeTargets,
  repositoryLockPath,
  safeTargetReason,
  systemReviewLimitFailure,
  type TestIsolationSource,
  validateMergePushConfig,
  WorkerGitTransport,
  type WorkspacePackage,
  withPreparationQueue,
} from "@cardigan/host";
import type { DeliveryVerifierFor } from "@cardigan/mcp-server";
import {
  type AgentCheckListing,
  type AgentExecution,
  agentListChecks,
  agentReceivePack,
  agentUploadPack,
  type ExecutionConfig,
  matchesAgentBundleOrigin,
  mirrorReceivePack,
  workerGit,
  workerGitPack,
} from "@cardigan/runtime-herdr";
import type {
  ProjectRecord,
  Store,
  StoreTransactionContext,
} from "@cardigan/store";
import type { CentralMaintenanceGit } from "./central-maintenance-loop.js";
import { backupBranches, backupWriter } from "./git-backup.js";
import type { SnapshotOrphan } from "./orphan-cleanup.js";

/**
 * M4.4: the server's Git assembly.
 *
 * §20.2 keeps Git behind `domain` ports: this module is the one place that
 * binds the ports to the real transports for the MCP endpoint and the control
 * plane. It hands out one verifier per project (§12.3) and one worktree service
 * for all projects (paths are project-scoped).
 */
export interface ServerGitOptions {
  readonly targets?: RuntimeTargets;
  /** Host-only adapter for an existing enforced input boundary. No repo discovery. */
  readonly testReview?: {
    readonly policyFile: (project: string) => string | undefined;
    readonly source: TestIsolationSource;
  };
  readonly buildCheckoutCacheMs?: number;
  readonly store: Pick<Store, "getProject" | "listProjects"> &
    Partial<Pick<Store, "uow" | "changesSince" | "setTestReviewTrust">>;
  readonly dataDir: string;
  readonly checkCleanupGraceMs?: number;
  /** Defaults to local mode; `agent-ssh` routes workspace Git via the Agent. */
  readonly execution?: ExecutionConfig;
  /**
   * agent-ssh only: run a command as the agent account. The server never
   * executes Git inside an Agent-writable repository as its own user (§12.6).
   */
  readonly captureAgent?: (
    command: "git",
    args: readonly string[],
    timeoutMs?: number,
  ) => Promise<
    | { readonly ok: true; readonly value: string }
    | {
        readonly ok: false;
        readonly error: {
          readonly code: string;
          readonly message: string;
          /** The Agent-side Git exit status and stderr (redact before use). */
          readonly detail?: {
            readonly exit_code?: number;
            readonly stderr: string;
          };
        };
      }
  >;
  /**
   * agent-ssh upload-pack command builder. Production uses `agentUploadPack`
   * (the dedicated SSH entry); tests inject a local one so they can run the
   * real fetch against a real Agent-layout clone.
   */
  readonly uploadPack?: (
    repository: string,
    execution?: AgentExecution,
  ) => Promise<string>;
  readonly receivePack?: (
    repository: string,
    execution: AgentExecution,
  ) => Promise<string>;
  /**
   * P2a-12 C: the non-local merge-check executor of a project, if any. Its
   * check directories live on another machine and are listed over SSH.
   */
  readonly checkExecutor?: (project_id: string) => AgentExecution | undefined;
  /**
   * C-628: one line per delivery source that could not be read, with its
   * class (busy, runtime target, other) and never the exception text.
   */
  readonly onSourceError?: (entry: DeliverySourceErrorEntry) => void;
  /** C-642: one line per delivery source publication, with lock wait and hold. */
  readonly onSourceLock?: (entry: DeliverySourceLockEntry) => void;
  /** C-636: wait/hold time of each project repository lock use. */
  readonly onLockSample?: (sample: RepositoryLockSample) => void;
  /** Test seam for the SSH listing; production uses `agentListChecks`. */
  readonly listChecks?: (
    execution: AgentExecution,
    project_id: string,
  ) => Promise<AgentCheckListing>;
}

/**
 * C-628: why a Git delivery source could not be read. A lock timeout is
 * "busy, retry later" (the caller may queue), a runtime target refusal keeps
 * its fixed reason code, and anything else only its error class.
 */
export type DeliverySourceError =
  | { readonly source_error: "repository_busy"; readonly retryable: true }
  | {
      readonly source_error: "runtime_target";
      readonly reason: string;
      readonly retryable: boolean;
    }
  | {
      readonly source_error: "other";
      readonly error_class: string;
      readonly retryable: false;
    };
export type DeliverySourceErrorEntry = DeliverySourceError & {
  readonly event: "delivery_source_error";
  readonly project_id: string;
  readonly assignment_id: string;
};

export interface DeliverySourceLockEntry {
  readonly event: "delivery_source_lock";
  readonly project_id: string;
  readonly assignment_id: string;
  readonly operation: "verify" | "head";
  readonly wait_ms: number;
  readonly held_ms: number;
}

const ERROR_CLASS = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
export function classifyDeliverySourceError(
  error: unknown,
): DeliverySourceError {
  if (
    error instanceof RepositoryLockTimeoutError ||
    error instanceof PreparationQueueTimeout
  )
    return { source_error: "repository_busy", retryable: true };
  if (error instanceof RuntimeTargetError)
    return {
      source_error: "runtime_target",
      // Both lists are fixed codes; anything else is `target_invalid`.
      reason: error.transient ? error.reason : safeTargetReason(error),
      retryable: error.transient,
    };
  const name =
    error instanceof Error ? (error.constructor?.name ?? error.name) : "";
  return {
    source_error: "other",
    error_class: ERROR_CLASS.test(name) ? name : "unknown",
    retryable: false,
  };
}

export function deliverySourceFailure(failure: DeliverySourceError) {
  const message =
    failure.source_error === "repository_busy"
      ? "Git delivery source is busy (仓库忙，稍后重试)"
      : failure.source_error === "runtime_target"
        ? `Git delivery source is unavailable: runtime target ${failure.reason}`
        : "Git delivery source is unavailable";
  return {
    ok: false as const,
    error: {
      code: "validation_failed" as const,
      message,
      details: { ...failure },
    },
  };
}

/** The candidate transport was never entered, even if other Git work was done. */
export class CandidatePushNotStarted extends RepositoryLockTimeoutError {}

/** Only a proven pre-transport lock timeout can release a GitHub publication fence. */
export async function pushCheckCandidateOrWait(
  push: () => Promise<PushResult>,
) {
  try {
    return await push();
  } catch (error) {
    if (error instanceof CandidatePushNotStarted)
      return { status: "not_started" } as const;
    throw error;
  }
}

/** What the loops need; tests substitute a plain object. */
export interface MergeGit {
  deleteCheckCandidate?(
    project: CentralProject,
    input: CandidateDeleteRequest,
  ): Promise<boolean>;
  pushCheckCandidate?(
    project: CentralProject,
    input: CandidatePushRequest,
  ): Promise<PushResult>;
  isBaselineAncestor?(
    project: CentralProject,
    sha: string,
    branch: string,
  ): Promise<boolean>;
  proveReviewLimit?(
    project: ProjectId,
    candidate: SystemReviewLimitCandidate,
  ): Promise<SystemReviewLimitOutcome>;
  prepareBatch?(
    project: CentralProject,
    plans: readonly MergePlan[],
  ): ReturnType<CentralRepositoryService["prepareBatch"]>;
  pinBatch?(project: CentralProject, batch: MergeBatch): Promise<void>;
  publishBatch?(
    project: CentralProject,
    batch: MergeBatch,
  ): ReturnType<CentralRepositoryService["publishBatch"]>;
  projectOf(project_id: ProjectId): CentralProject | undefined;
  sync(project: CentralProject): Promise<SourceSync>;
  merge(project: CentralProject, plan: MergePlan): Promise<MergeOutcome>;
  baseline?(project: CentralProject): Promise<string>;
  deliveryChangedPaths?(
    project: CentralProject,
    base: string,
    commit: string,
  ): Promise<readonly string[]>;
  changedPaths?(
    project: CentralProject,
    base: string,
    commit: string,
  ): Promise<readonly string[]>;
  prepare?(project: CentralProject, plan: MergePlan): Promise<PreparedMerge>;
  publish?(
    project: CentralProject,
    completion: DeliveryId,
    candidate: Extract<PreparedMerge, { status: "candidate" }>,
    guard: GitPublicationGuard,
  ): Promise<
    | Extract<MergeOutcome, { status: "stale" }>
    | (Extract<MergeOutcome, { status: "merged" }> & {
        readonly tree_sha: string;
      })
  >;
  /** `execution` overrides the server's default target (P2a-12 C). */
  distribute?(
    project: CentralProject,
    execution?: ExecutionConfig,
  ): Promise<void>;
  push?(
    project: CentralProject,
    input: { sha: string; included: readonly string[] },
    config: MergePushConfig,
    signal?: AbortSignal,
  ): Promise<PushResult>;
  /** Current central baseline head plus its first-parent commits down to base. */
  pushRange?(
    project: CentralProject,
    base: string,
    limit: number,
  ): Promise<{
    readonly head: string;
    readonly chain: readonly MergePushCommit[];
    readonly truncated: boolean;
  }>;
}
export type ReconcilePages = AsyncGenerator<void, readonly ReconcileFinding[]>;
export interface MachineDirectories {
  readonly builds: readonly string[];
  readonly worktrees: readonly string[];
}
export interface ReconcileGit {
  reconcilePages?(
    ...args: Parameters<ReconcileGit["reconcile"]>
  ): ReconcilePages;
  refreshLocalMirror?(project: CentralProject): Promise<void>;
  projectOf(project_id: ProjectId): CentralProject | undefined;
  reconcile(
    project: CentralProject,
    assignments: readonly Assignment[],
    deliveries: readonly Delivery[],
    /** The loop supplies current check ownership after the filesystem scan. */
    readChecks?: () => ReconcileChecks,
  ): Promise<readonly ReconcileFinding[]>;
  removeWorktree(input: RemoveWorktreeInput): Promise<RemoveWorktreeOutcome>;
  /** P2a-3: Assignment ids that have a verifier build checkout on disk or in Git. */
  listBuildCheckouts?(
    project: CentralProject,
  ): Promise<readonly string[] | undefined>;
  /**
   * C-664: Assignment ids under one machine's `builds/<project>` and
   * `worktrees/<project>` roots, read through that machine's file and Git
   * port (a worker's helper, never host `access()`). `undefined` while a
   * preparation runs; throws when the machine cannot be read.
   */
  listMachineDirectories?(
    project: CentralProject,
    machine_id: string,
  ): Promise<MachineDirectories | undefined>;
  /** P2a-3: `idle` is re-checked under the project's repository lock. */
  removeBuildCheckout?(input: {
    readonly project: CentralProject;
    readonly assignment_id: string;
    readonly idle: () => boolean;
  }): Promise<RemoveBuildOutcome>;
  diffWorktree(input: {
    readonly project: CentralProject;
    readonly assignment: Assignment;
  }): Promise<WorktreeDiff>;
  backup(project: CentralProject): Promise<void>;
  /** §3.3: re-create a missing fixed ref from the candidate ref, if it exists. */
  repairPin(
    project: CentralProject,
    delivery: Delivery,
    assignment: Assignment,
  ): Promise<boolean>;
}

/** The repository roots a checkout layout uses for this execution mode. */
export function gitRoots(
  execution: ExecutionConfig,
  dataDir: string,
): {
  repositoriesRoot: string;
  worktreesRoot: string;
  checksRoot: string;
  buildsRoot: string;
} {
  const root =
    execution.mode === "local" ? join(dataDir, "agent") : execution.agentRoot;
  return {
    repositoriesRoot: join(root, "repos"),
    worktreesRoot: join(root, "worktrees"),
    checksRoot: join(root, "checks"),
    buildsRoot: join(root, "builds"),
  };
}

/**
 * Agent-ssh: the same `git` argv runs under the agent account through the
 * runtime's dedicated SSH entry, with the target marked safe explicitly.
 */
function agentWorkspace(
  captureAgent: NonNullable<ServerGitOptions["captureAgent"]>,
): WorkspaceGitPort {
  return {
    run: async (args, timeoutMs) => {
      const at = args.indexOf("-C"),
        target = at >= 0 ? args[at + 1] : undefined;
      const result = await captureAgent(
        "git",
        [
          ...(target === undefined ? [] : ["-c", `safe.directory=${target}`]),
          ...args,
        ],
        timeoutMs,
      );
      if (!result.ok)
        throw Object.assign(
          new Error(`${result.error.code}: ${result.error.message}`),
          {
            code: result.error.detail?.exit_code ?? result.error.code,
            stderr: result.error.detail?.stderr ?? "",
          },
        );
      return result.value;
    },
  };
}

/** What the control plane's phase loops need: merge plus cleanup/reconcile. */
export type GitPhases = MergeGit &
  ReconcileGit &
  CentralMaintenanceGit & {
    snapshotOrphan?: SnapshotOrphan;
  };

/**
 * Everything apps/server needs from Git in one object. Tests that only exercise
 * routing inject a stub; production always uses `ServerGit` (real Git).
 */
export interface GitBinding extends GitPhases {
  stallBackup?(
    project: ProjectId,
    a: Assignment,
    action: string,
  ): Promise<{ ref: string; sha: string }>;
  checkHead?(project: ProjectId, assignment: Assignment): Promise<string>;
  readonly verifierFor: DeliveryVerifierFor;
  pinDelivery(input: {
    readonly project_id: ProjectId;
    readonly delivery_id: string;
    readonly sha: string;
  }): Promise<void>;
}

export class ServerGit implements GitBinding {
  private readonly buildCacheMs: number;
  private readonly buildCache = new Map<
    string,
    { at: number; fingerprint: string; owners: readonly string[] }
  >();
  private readonly buildQueries = new Map<
    string,
    { fingerprint: string; query: Promise<readonly string[]> }
  >();
  private readonly buildEpochs = new Map<string, number>();
  private missingBuildVersion = 0;
  private invalidateBuilds(project: string) {
    this.buildCache.delete(project);
    this.buildEpochs.set(project, (this.buildEpochs.get(project) ?? 0) + 1);
  }
  private readonly central: CentralRepositoryService;
  private readonly transport: CentralGitTransport;
  private readonly worktrees: GitWorktreeService;
  /** §12.8: one per-project lock for every write to the shared base clone. */
  private readonly lock: RepositoryLock;

  constructor(private readonly options: ServerGitOptions) {
    this.buildCacheMs =
      options.buildCheckoutCacheMs ??
      Number(process.env.CARDIGAN_BUILD_CHECKOUT_CACHE_MS ?? 60_000);
    if (
      !Number.isSafeInteger(this.buildCacheMs) ||
      this.buildCacheMs < 1 ||
      this.buildCacheMs > 2_147_483_647
    )
      throw new Error(
        "CARDIGAN_BUILD_CHECKOUT_CACHE_MS must be an integer between 1 and 2147483647",
      );
    const execution =
      options.execution ??
      ({ mode: "local", dataDir: options.dataDir } as const);
    if (execution.mode === "agent-ssh" && options.captureAgent === undefined)
      throw new Error(
        "agent-ssh Git requires the Agent execution entry; refusing to run workspace Git as the host",
      );
    const roots = gitRoots(execution, options.dataDir);
    const centralTransport = new CentralGitTransport({
      dataDir: options.dataDir,
      ...(execution.mode === "agent-ssh"
        ? { agentRoot: execution.agentRoot }
        : {}),
    });
    this.transport = centralTransport;
    this.central = new CentralRepositoryService(centralTransport, {
      dataDir: options.dataDir,
      // The base clone lives under the Agent root in agent-ssh mode; fetching
      // deliveries and backups from the wrong path would fail every time.
      repositoriesRoot: roots.repositoriesRoot,
      ...(execution.mode === "agent-ssh"
        ? {
            uploadPack:
              options.uploadPack ??
              ((repository: string) =>
                agentUploadPack(execution as AgentExecution, repository)),
          }
        : {}),
    });
    options.store.setTestReviewTrust?.(
      options.testReview && execution.mode === "agent-ssh"
        ? new HostTestReviewTrust({
            git: centralTransport,
            repository: (id) => {
              const p = this.projectOf(id as ProjectId);
              return p ? this.central.repositoryPath(p) : undefined;
            },
            baseline: async (id, branch) => {
              const p = this.projectOf(id as ProjectId);
              return p && validCentralBranch(branch)
                ? centralTransport.readRef(
                    this.central.repositoryPath(p),
                    `refs/heads/${branch}`,
                  )
                : undefined;
            },
            baselineNow: (id, branch) => {
              const p = this.projectOf(id as ProjectId);
              return p && validCentralBranch(branch)
                ? centralTransport.readRefSync(
                    this.central.repositoryPath(p),
                    `refs/heads/${branch}`,
                  )
                : undefined;
            },
            pinned: async (id, delivery) => {
              const p = this.projectOf(id as ProjectId);
              return p
                ? centralTransport.readRef(
                    this.central.repositoryPath(p),
                    `refs/cardigan/deliveries/${delivery}`,
                  )
                : undefined;
            },
            ...options.testReview,
          })
        : undefined,
    );
    this.lock = hostRepositoryLock(
      options.dataDir,
      options.onLockSample ? { observe: options.onLockSample } : {},
    );
    const workspace =
      execution.mode === "agent-ssh" && options.captureAgent !== undefined
        ? agentWorkspace(options.captureAgent)
        : undefined;
    this.worktrees = new GitWorktreeService(
      new LocalGitTransport("git", {}, workspace),
      this.central,
      {
        dataDir: options.dataDir,
        ...roots,
        // Same per-project lock as the wake/start path (§12.8).
        lock: this.lock,
      },
    );
  }

  /** The central-repository descriptor of a project, or nothing without a repo. */
  projectOf(project_id: ProjectId): CentralProject | undefined {
    // No cache: `cardigan project set-repo` must take effect without a restart.
    const record: ProjectRecord | undefined = this.options.store.getProject(
      project_id as never,
    );
    const project =
      record?.repo_path === null || record?.repo_path === undefined
        ? undefined
        : {
            project_id: record.id,
            source_repo: record.repo_path,
            base_branch: record.base_branch ?? "main",
          };
    return project;
  }

  /** Every project that can own a central repository (§3.1). */
  projects(): readonly CentralProject[] {
    return this.options.store.listProjects().flatMap((record) => {
      const project = this.projectOf(record.id);
      return project === undefined ? [] : [project];
    });
  }

  /**
   * §3.3 step 1: one verifier per project, because Assignment ids are only
   * unique inside a project. A project without a repository cannot accept a
   * Git delivery, but non-Git subjects are still verified by their own rules.
   */
  readonly verifierFor: DeliveryVerifierFor = (project_id) => {
    const project = this.projectOf(project_id);
    if (project === undefined)
      return {
        verify: async (subject: DeliverySubject) =>
          subject.kind === "git_head"
            ? validationFailed(
                "Project has no registered repository for Git deliveries",
              )
            : { ok: true, value: [] },
      } satisfies DeliveryVerifier;
    return {
      verify: async (subject, assignment, previous) => {
        if (subject.kind !== "git_head") return { ok: true, value: [] };
        try {
          return await this.withAssignmentSource(
            project,
            assignment,
            "verify",
            (central) =>
              new GitDeliveryVerifier(
                central,
                project,
                this.cardBaselineOf(project, assignment),
              ).prepareVerify(subject, assignment, previous),
          );
        } catch (error) {
          const failure = classifyDeliverySourceError(error);
          try {
            this.options.onSourceError?.({
              event: "delivery_source_error",
              project_id: project.project_id,
              assignment_id: assignment.id,
              ...failure,
            });
          } catch {
            // A failing log never changes the answer.
          }
          return deliverySourceFailure(failure);
        }
      },
    } satisfies DeliveryVerifier;
  };

  /**
   * C-654: the card's own baseline branch (C-589), against which the author's
   * own changes are measured. Undefined means the project baseline.
   */
  private cardBaselineOf(
    project: CentralProject,
    assignment: Assignment,
  ): string | undefined {
    const uow = this.options.store.uow;
    if (!uow || assignment.scope !== "work_item") return undefined;
    const branch = uow.read((tx) => {
      const item = tx.work_items.get(
        project.project_id as ProjectId,
        assignment.work_item_id,
      );
      return item
        ? tx.cards.get(project.project_id as ProjectId, item.card_id)
            ?.base_branch
        : undefined;
    });
    return branch && branch !== project.base_branch ? branch : undefined;
  }

  async checkHead(
    projectId: ProjectId,
    assignment: Assignment,
  ): Promise<string> {
    const project = this.projectOf(projectId);
    if (!project) throw new CheckHeadFailure("environment_unavailable");
    try {
      return await this.withAssignmentSource(
        project,
        assignment,
        "head",
        (central) =>
          new GitDeliveryVerifier(central, project).prepareHead(assignment),
      );
    } catch (error) {
      // Lock timeouts stay retryable for every caller; the remaining setup
      // failures (worker target or helper resolution) name the environment.
      if (
        error instanceof RepositoryLockTimeoutError ||
        error instanceof CheckHeadFailure
      )
        throw error;
      throw new CheckHeadFailure("environment_unavailable", { cause: error });
    }
  }
  preparePrecheck(
    project: CentralProject,
    assignment: string,
    head: string,
    attempt: string,
  ) {
    return this.central.preparePrecheck(project, assignment, head, attempt);
  }
  /** C-611: the pinned delivery merged onto the current baseline. */
  prepareDeliveryCandidate(
    project: CentralProject,
    delivery: string,
    head: string,
  ) {
    return this.central.prepareDeliveryCandidate(project, delivery, head);
  }
  /** §3.3 step 2; a failure here is logged by the caller and repaired by reconcile. */
  async pinDelivery(input: {
    readonly project_id: ProjectId;
    readonly delivery_id: string;
    readonly sha: string;
  }): Promise<void> {
    const project = this.projectOf(input.project_id);
    if (project === undefined)
      throw new Error("Project has no registered repository");
    await this.central.pinDelivery(project, input.delivery_id, input.sha);
  }

  async sync(project: CentralProject): Promise<SourceSync> {
    return this.central.syncFromSource(project);
  }
  async merge(project: CentralProject, plan: MergePlan): Promise<MergeOutcome> {
    return this.central.mergeIntoBase(project, plan);
  }
  async proveReviewLimit(
    projectId: ProjectId,
    candidate: SystemReviewLimitCandidate,
  ) {
    let stage: SystemReviewLimitFailure["stage"] = "repository";
    try {
      const project = this.projectOf(projectId);
      if (!project) return null;
      const repository = await this.central.ensureCentral(project);
      stage = "proof";
      // The card's own baseline branch; an unusable name proves nothing.
      if (!validCentralBranch(candidate.base_branch)) return null;
      return await proveSystemReviewLimit(
        this.transport,
        repository,
        candidate.base_branch,
        candidate,
      );
    } catch (error) {
      return systemReviewLimitFailure(error, stage);
    }
  }
  async baseline(project: CentralProject): Promise<string> {
    const repository = await this.central.ensureCentral(project);
    const sha = await this.central.git.readRef(
      repository,
      `refs/heads/${project.base_branch}`,
    );
    if (!sha) throw new Error("Central baseline is missing");
    return sha;
  }
  async pushCheckCandidate(
    project: CentralProject,
    input: CandidatePushRequest,
  ): Promise<PushResult> {
    const repository = await this.central.ensureCentral(project);
    // C-636: only the local check of the candidate commit holds the project
    // lock. The GitHub push only reads that immutable object (the center is
    // never pruned), so it runs outside and no longer blocks worktree
    // preparation, delivery reads or other candidates for its whole transfer.
    const present = await this.withCandidateLock(
      project,
      repository,
      "candidate.check",
      // Like the transport, an unreadable or invalid object is a failed push.
      async () =>
        (await this.transport
          .objectType(repository, input.sha)
          .catch(() => undefined)) === "commit",
    );
    if (!present) return { status: "failed", reason: "other" };
    return this.transport.pushCandidateCommit(repository, input);
  }
  /** A lock timeout before `transfer` started proves nothing was sent. */
  private async withCandidateLock<T>(
    project: CentralProject,
    repository: string,
    operation: string,
    transfer: () => Promise<T>,
  ): Promise<T> {
    let started = false;
    try {
      return await this.lock(
        { project_id: project.project_id, repository, operation },
        () => {
          started = true;
          return transfer();
        },
      );
    } catch (error) {
      if (!started && error instanceof RepositoryLockTimeoutError)
        throw new CandidatePushNotStarted(error.waitMs);
      throw error;
    }
  }
  async deleteCheckCandidate(
    project: CentralProject,
    input: CandidateDeleteRequest,
  ): Promise<boolean> {
    const repository = await this.central.ensureCentral(project);
    // This only reads local repository metadata and compare-deletes a remote ref.
    // Remote IO must not hold the project lock needed by candidate publication
    // and worktree preparation; the journal fence and exact SHA lease protect it.
    return this.transport.deleteCandidateCommit(repository, input);
  }
  async isBaselineAncestor(
    project: CentralProject,
    sha: string,
    branch: string,
  ): Promise<boolean> {
    if (branch !== project.base_branch || !/^[a-f0-9]{40}$/u.test(sha))
      return false;
    const repository = await this.central.ensureCentral(project);
    return this.transport.isAncestor(
      repository,
      sha,
      await this.baseline(project),
    );
  }
  /**
   * Read-only fixed-object validation. C-636: no project lock: it only reads
   * immutable objects and one ref, and a ref read is atomic, so a concurrent
   * baseline update yields the old or the new value, never a torn one.
   */
  async verifyCheckCandidate(
    project: CentralProject,
    candidate: { sha: string; tree: string; base: string },
  ): Promise<void> {
    const repository = this.central.repositoryPath(project);
    if (
      ![candidate.sha, candidate.tree, candidate.base].every((s) =>
        /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(s),
      ) ||
      (await this.transport.objectType(repository, candidate.sha)) !==
        "commit" ||
      (await this.transport.treeOfCommit(repository, candidate.sha)) !==
        candidate.tree ||
      (await this.transport.readRef(
        repository,
        `refs/heads/${project.base_branch}`,
      )) !== candidate.base ||
      !(await this.transport.isAncestor(
        repository,
        candidate.base,
        candidate.sha,
      ))
    )
      throw new Error("固定候选或基线已改变");
  }
  prepareBatch(project: CentralProject, plans: readonly MergePlan[]) {
    return this.central.prepareBatch(project, plans);
  }
  pinBatch(project: CentralProject, batch: MergeBatch) {
    return this.central.pinBatch(project, batch);
  }
  publishBatch(project: CentralProject, batch: MergeBatch) {
    return this.central.publishBatch(project, batch);
  }
  prepare(project: CentralProject, plan: MergePlan): Promise<PreparedMerge> {
    return this.central.prepareMerge(project, plan);
  }
  async publish(
    project: CentralProject,
    completion: DeliveryId,
    candidate: Extract<PreparedMerge, { status: "candidate" }>,
    guard?: GitPublicationGuard,
  ) {
    const repository = await this.central.ensureCentral(project);
    // Re-read the immutable commit in the host-owned center before any ref
    // mutation. Never accept a caller's tree as proof of what will be published.
    const tree = await this.transport.treeOfCommit(
      repository,
      candidate.candidate_sha,
    );
    if (tree !== candidate.tree_sha)
      throw new Error("Candidate tree does not match the checked tree");
    const result = await this.central.publishMerge(
      project,
      completion,
      candidate.candidate_sha,
      candidate.previous_sha,
      guard,
    );
    return result.status === "merged" ? { ...result, tree_sha: tree } : result;
  }
  /**
   * P2a-13 A1: paths changed from `base` to `commit`, read in the center only.
   * Both must be full commit SHAs; refs are refused (the transport checks).
   */
  async deliveryChangedPaths(
    project: CentralProject,
    base: string,
    commit: string,
  ): Promise<readonly string[]> {
    const repository = await this.central.ensureCentral(project);
    return this.transport.deliveryChangedPaths(repository, base, commit);
  }
  async changedPaths(
    project: CentralProject,
    base: string,
    commit: string,
  ): Promise<readonly string[]> {
    const repository = await this.central.ensureCentral(project);
    return this.transport.changedPaths(repository, base, commit);
  }
  /**
   * P2a-13 A1: the workspace packages of one candidate commit, read from that
   * commit's tree in the center (`pnpm-workspace.yaml` and each member's
   * `package.json`). Nothing outside the commit's tree is read.
   */
  async readWorkspace(
    project: CentralProject,
    commit: string,
  ): Promise<readonly WorkspacePackage[]> {
    const repository = await this.central.ensureCentral(project);
    return loadWorkspace({
      listDirectories: async (directory) =>
        (await this.transport.listTree(repository, commit, directory))
          .filter((entry) => entry.type === "tree")
          .map((entry) => entry.path),
      readFile: (path) => this.transport.readTreeFile(repository, commit, path),
    });
  }
  /** Q-649: immutable eligible files of the actual merged candidate, never source HEAD. */
  async readCandidateTests(
    project: CentralProject,
    commit: string,
  ): Promise<CandidateTestSnapshot> {
    const repository = await this.central.ensureCentral(project);
    const tree_sha = await this.transport.treeOfCommit(repository, commit);
    const files: CandidateTestSnapshot["files"][number][] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await this.transport.listTree(
        repository,
        commit,
        directory,
      )) {
        if (entry.type === "tree") await walk(entry.path);
        else if (
          entry.type === "blob" &&
          ["100644", "100755"].includes(entry.mode) &&
          candidateTestPath(entry.path)
        )
          files.push(entry);
      }
    };
    for (const root of ["packages", "apps"]) {
      for (const entry of await this.transport.listTree(
        repository,
        commit,
        root,
      ))
        if (
          entry.type === "tree" &&
          new RegExp(`^${root}/[a-z0-9-]+$`, "u").test(entry.path)
        )
          await walk(`${entry.path}/src`);
    }
    return { candidate_sha: commit, tree_sha, files };
  }
  /**
   * Push candidates to an execution target's base clone. Without `override`
   * this is the server's default execution, exactly as for development
   * Agents; a merge check passes its project's executor instead (P2a-12 C).
   */
  async distribute(
    project: CentralProject,
    override?: ExecutionConfig,
  ): Promise<void> {
    const execution = override ??
      this.options.execution ?? {
        mode: "local",
        dataDir: this.options.dataDir,
      };
    const source = await this.central.ensureCentral(project);
    const repository = resolve(
      gitRoots(execution, this.options.dataDir).repositoriesRoot,
      project.project_id,
    );
    // Candidate distribution updates the base clone's refs: it shares the
    // wake path's project lock, held only for the transfer, not the checks.
    await this.withCandidateLock(
      project,
      repository,
      "candidate.distribute",
      () => this.transfer(execution, source, repository),
    );
  }
  private async transfer(
    execution: ExecutionConfig,
    source: string,
    repository: string,
  ): Promise<void> {
    if (execution.mode === "agent-ssh") {
      // Accepted Git deliveries already have a base clone. If it disappeared,
      // fail this attempt; never recreate an Agent repository as the host.
      // An overriding executor's clone may be on another machine (P2a-12 C).
      await this.transport.pushBaseline(
        source,
        repository,
        await (
          this.options.receivePack ??
          ((path: string) => agentReceivePack(execution, path))
        )(repository, execution),
        execution === this.options.execution ? undefined : execution.agentRoot,
      );
    } else {
      const local = new LocalGitTransport();
      await local.ensureClone(source, repository);
      await local.fetch(repository, source);
    }
  }
  async push(
    project: CentralProject,
    input: { sha: string; included: readonly string[] },
    config: MergePushConfig,
    signal?: AbortSignal,
  ): Promise<PushResult> {
    try {
      await validateMergePushConfig(config, this.options.dataDir);
    } catch {
      return { status: "failed", reason: "auth" };
    }
    try {
      const repository = await this.central.ensureCentral(project);
      for (const sha of input.included) {
        if (
          (await this.transport.objectType(repository, sha)) !== "commit" ||
          !(await this.transport.isAncestor(repository, sha, input.sha))
        )
          return { status: "failed", reason: "other" };
      }
      return await this.transport.pushMergedCommit(repository, {
        ...config,
        sha: input.sha,
        ...(signal ? { signal } : {}),
      });
    } catch {
      return { status: "failed", reason: "other" };
    }
  }
  async pushRange(
    project: CentralProject,
    base: string,
    limit: number,
    pageSize = 1_000,
  ) {
    const repository = await this.central.ensureCentral(project);
    const head = await this.central.git.readRef(
      repository,
      `refs/heads/${project.base_branch}`,
    );
    if (
      !head ||
      (await this.transport.objectType(repository, head)) !== "commit" ||
      (await this.transport.objectType(repository, base)) !== "commit"
    )
      throw new Error("Push range endpoints must be commits");
    // Page down the first-parent chain; each page continues from the last
    // parent, so the whole chain is read in linear time up to `limit`.
    const chain: MergePushCommit[] = [];
    let tip: string | undefined = head;
    while (tip && tip !== base && chain.length < limit) {
      const page = await this.transport.firstParentChain(
        repository,
        base,
        tip,
        Math.min(pageSize, limit - chain.length),
      );
      chain.push(...page);
      tip = page.length ? page.at(-1)?.parent : undefined;
    }
    const truncated = Boolean(tip && tip !== base && chain.length >= limit);
    return { head, chain, truncated };
  }
  /** A single registered writer, never the periodic all-branches sweep. Pin the
   * transported commit in the host-owned center, not inside an agent checkout. */
  async stallBackup(id: ProjectId, assignment: Assignment, action: string) {
    const project = this.projectOf(id),
      uow = this.options.store.uow;
    if (!project || !uow || !backupWriter(assignment))
      throw new Error("Stall backup unavailable");
    const source = this.workspaceServices(project, assignment);
    const tip = await backupBranches(
      {
        project,
        currentProject: () => this.projectOf(id),
        lock: this.lock,
        uow,
        ...source,
      },
      { assignment },
    );
    if (!tip) throw new Error("Stall branch backup missing");
    const git = source.central.git,
      repo = await source.central.ensureCentral(project);
    return this.lock(
      { project_id: id, repository: repo, operation: "backup.stall_pin" },
      () =>
        pinStallBackup(
          {
            create: (ref, sha) => git.compareAndSwapRef(repo, ref, sha, null),
            read: (ref) => git.readRef(repo, ref),
            tree: (sha) => git.treeOfCommit(repo, sha),
          },
          assignment.id,
          action,
          tip.sha,
        ),
    );
  }
  async snapshotOrphan(
    id: ProjectId,
    assignment: Assignment,
    verification?: Parameters<SnapshotOrphan>[2],
  ) {
    const project = this.projectOf(id);
    const ref = assignment.runtime_ref;
    const generation = ref?.launch_generation?.generation;
    if (
      !project ||
      !ref ||
      !generation ||
      !assignment.branch ||
      assignment.worktree_path !== ref.worktree_path ||
      assignment.branch !== ref.branch
    )
      throw new Error("Orphan workspace not bound");
    const execution = this.options.targets?.executionForRef(ref, id);
    if (execution?.mode !== "agent-ssh" || !assignment.worktree_path)
      throw new Error("Worker unavailable");
    const { central, validateTarget } = this.workspaceServices(
      project,
      assignment,
    );
    const backup = `refs/cardigan/backups/orphans/${assignment.id}/${generation}`;
    const sha = await workerGit<string | null>(execution, {
      project: id,
      assignment: assignment.id,
      operation: verification ? "verify-sealed-snapshot" : "snapshot",
      ...(verification
        ? { process: verification.process, expected: verification.sha }
        : {}),
      timeout_ms: 60_000,
      repository: assignment.worktree_path,
      branch: assignment.branch,
      generation,
    });
    validateTarget?.();
    if (!sha) return null;
    if (verification && sha !== verification.sha)
      throw new Error("Workspace changed");
    const repository = await central.ensureCentral(project);
    if (!verification) {
      const source = await central.agentSource(project, assignment.machine_id);
      validateTarget?.();
      await central.git.fetchRefs(
        repository,
        source.address,
        [`${backup}:${backup}`],
        source.uploadPack,
      );
    }
    if (
      (await central.git.readRef(repository, backup)) !== sha ||
      (await central.git.objectType(repository, sha)) !== "commit"
    )
      throw new Error("Snapshot verification failed");
    validateTarget?.();
    return sha;
  }
  /**
   * C-637: the existing central repository for off-peak maintenance. It never
   * creates one and never takes the repository lock; a separate per-project
   * flock only keeps two host processes from repacking at the same time.
   */
  async centralMaintenance(project: CentralProject) {
    const repository = this.central.repositoryPath(project);
    const present = await lstat(repository).then(
      (entry) => entry.isDirectory(),
      (error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      },
    );
    if (!present) return undefined;
    let release = async () => {};
    if (process.platform === "linux")
      try {
        release = await acquireRepositoryFlock(
          join(
            dirname(
              repositoryLockPath(this.options.dataDir, project.project_id),
            ),
            `maintenance-${project.project_id}.lock`,
          ),
          1,
        );
      } catch (error) {
        if (error instanceof RepositoryLockTimeoutError) return undefined;
        throw error;
      }
    const transport = this.transport;
    return {
      target: {
        lastCruftPack: () => transport.lastCruftPack(repository),
        repack: (mode: CentralRepackMode) => transport.repack(repository, mode),
        listRefs: (prefix: string) => transport.listRefs(repository, prefix),
        deleteRefs: (refs: readonly GitRef[]) =>
          transport.deleteRetainedRefs(repository, refs),
      },
      release,
    };
  }
  async backup(project: CentralProject): Promise<void> {
    const projectId = project.project_id as ProjectId;
    const uow = this.options.store.uow;
    if (!uow) throw new Error("Backup requires current Assignment state");
    const assignments = uow.read((tx) => tx.assignments.list(projectId));
    const writers = assignments.filter(backupWriter);
    const context = {
      project,
      currentProject: () => this.projectOf(projectId),
      lock: this.lock,
      uow,
    };
    const localBranches = writers.flatMap((a) =>
      a.machine_id === "local" && a.branch ? [a.branch] : [],
    );
    const failures: string[] = [];
    let localFailure: unknown;
    // Preserve legacy unbound local branches as well as recorded Assignments.
    const local = assignments.find((a) => a.machine_id === "local");
    if (!this.options.targets || local) {
      try {
        const source =
          this.options.targets && local
            ? this.workspaceServices(project, local, "repository")
            : { central: this.central };
        await backupBranches(
          { ...context, ...source },
          { excludedBranches: localBranches },
        );
      } catch (error) {
        localFailure = error;
        failures.push("local");
      }
    }
    for (const assignment of writers) {
      try {
        const source = this.workspaceServices(project, assignment);
        await backupBranches({ ...context, ...source }, { assignment });
      } catch {
        failures.push(`${assignment.machine_id}/${assignment.id}`);
      }
    }
    if (failures.length === 1 && localFailure) throw localFailure;
    if (failures.length)
      throw new Error(`Branch backup failed: ${failures.join(", ")}`);
  }
  async repairPin(
    project: CentralProject,
    delivery: Delivery,
    assignment: Assignment,
  ): Promise<boolean> {
    if (delivery.subject.kind !== "git_head") return false;
    const repository = await this.central.ensureCentral(project),
      candidate = await this.central.git.readRef(
        repository,
        `refs/cardigan/candidates/${assignment.id}/${delivery.subject.value}`,
      );
    if (candidate !== delivery.subject.value) return false;
    await this.central.createRef(
      repository,
      `refs/cardigan/deliveries/${delivery.id}`,
      delivery.subject.value,
    );
    return true;
  }
  async refreshLocalMirror(project: CentralProject): Promise<void> {
    const source = this.central.repositoryPath(project); // validates project_id
    const execution = this.options.execution ?? {
      mode: "local",
      dataDir: this.options.dataDir,
    };
    if (
      execution.mode === "agent-ssh" &&
      ((execution.target && execution.target.machine_id !== "local") ||
        (execution.host &&
          !["localhost", "127.0.0.1", "::1"].includes(execution.host)))
    )
      throw new Error(
        "Mirror refresh requires the control host's local execution",
      );
    const repository = join(
      gitRoots(execution, this.options.dataDir).repositoriesRoot,
      project.project_id,
    );
    await this.lock(
      {
        project_id: project.project_id,
        repository,
        operation: "mirror.refresh",
      },
      async () => {
        const leaf = await lstat(repository).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;
          throw error;
        });
        if (!leaf) return; // Fetch only. Never create a clone or worktree here.
        if (
          !leaf.isDirectory() ||
          (await realpath(repository)) !== repository ||
          !(await lstat(join(repository, ".git"))).isDirectory()
        )
          throw new Error("Unexpected local mirror directory");
        await this.transport.verifyBareSource(
          source,
          await realpath(project.source_repo),
        );
        const workspace =
          execution.mode === "agent-ssh" && this.options.captureAgent
            ? agentWorkspace(this.options.captureAgent)
            : undefined;
        const local = new LocalGitTransport("git", {}, workspace);
        await local.verifyMirror(
          repository,
          source,
          execution.mode === "agent-ssh"
            ? (origin) =>
                matchesAgentBundleOrigin(
                  execution,
                  project.project_id,
                  origin,
                  source,
                )
            : undefined,
        );
        const receiver = await mirrorReceivePack(execution, repository);
        const transfer = () =>
          this.transport.distributeMirrorHeads(source, receiver);
        try {
          await transfer();
        } catch (error) {
          // Only retry if there is a concrete directory/file conflict to clear.
          const heads = await this.transport.listRefs(source, "refs/heads/");
          if (
            !(await local.clearMirrorNameConflicts(
              repository,
              heads.map(({ ref }) => ref.slice("refs/heads/".length)),
            ))
          )
            throw error;
          await transfer();
        }
      },
    );
  }
  async reconcile(
    ...args: Parameters<ReconcileGit["reconcile"]>
  ): Promise<readonly ReconcileFinding[]> {
    const pages = this.reconcilePages(...args);
    for (;;) {
      const page = await pages.next();
      if (page.done) return page.value;
    }
  }
  async *reconcilePages(
    project: CentralProject,
    assignments: readonly Assignment[],
    deliveries: readonly Delivery[],
    readChecks?: () => ReconcileChecks,
  ): ReconcilePages {
    // The local scan (readdir) always runs: it covers the default execution.
    const state = yield* this.worktrees.listWorktreeStatePages(project);
    const workers: ReconcileFinding[] = [];
    for (const assignment of assignments) {
      if (
        assignment.machine_id === "local" ||
        assignment.status !== "active" ||
        !assignment.worktree_path
      )
        continue;
      // Resume at most one targeted worker observation per timer page. No
      // partial inventory is published and no lock survives this yield.
      yield;
      const subject = {
        assignment_id: assignment.id,
        path: `${assignment.machine_id}:${assignment.worktree_path}`,
      };
      try {
        const target = this.options.targets?.forWorkspace(
          project.project_id as ProjectId,
          assignment,
        ).execution.target;
        const present = await this.worktreesFor(
          project,
          assignment,
        ).worktreeDirectoryExists(project.project_id, assignment);
        if (
          this.options.targets?.forWorkspace(
            project.project_id as ProjectId,
            assignment,
          ).execution.target?.fingerprint !== target?.fingerprint
        )
          throw new Error("Workspace target configuration changed");
        if (!present)
          workers.push({
            kind: "missing_worktree",
            detail: `Worker ${assignment.machine_id}: Active Assignment has no worktree directory (checked remotely)`,
            ...subject,
          });
      } catch {
        workers.push({
          kind: "worker_unchecked",
          detail: `远程未核：Worker ${assignment.machine_id} 的工作区无法通过已登记通道核对`,
          ...subject,
        });
      }
    }
    const executor = this.options.checkExecutor?.(project.project_id);
    const remote =
      executor &&
      (await this.worktrees.listExecutorChecks(project, {
        name: executor.machine,
        agentRoot: executor.agentRoot,
        list: (project_id) =>
          (this.options.listChecks ?? agentListChecks)(executor, project_id),
      }));
    // Read ownership after all directory IO so a newly queued check is protected.
    const read = readChecks?.();
    const checks = read && {
      ...read,
      ...(this.options.checkCleanupGraceMs === undefined
        ? {}
        : {
            cleanupGraceMs: this.options.checkCleanupGraceMs,
          }),
    };
    return [
      ...reconcile(state, assignments, deliveries, checks),
      ...workers,
      ...(remote
        ? reconcileExecutorChecks(remote, project.project_id, checks)
        : []),
    ];
  }
  /**
   * C-642: resolve the target and read the source (remote fetch, Git reads)
   * outside the project lock; the lock covers only the local ref publication,
   * which rechecks the target first. A rejection already decided only records
   * the fetched tip, best effort: a busy lock never replaces its reason.
   */
  private async withAssignmentSource<T>(
    project: CentralProject,
    assignment: Assignment,
    operation: "verify" | "head",
    prepare: (
      central: CentralRepositoryService,
    ) => Promise<StagedDeliverySource<T>>,
  ): Promise<T> {
    const staged = await prepare(
      this.workspaceServices(project, assignment).central,
    );
    const publish = <R>(write: () => Promise<R>) =>
      this.publishSource(project, assignment, operation, write);
    if (!("value" in staged)) return publish(staged.publish);
    const { record } = staged;
    if (record) await publish(record).catch(() => undefined);
    return staged.value;
  }
  private async publishSource<R>(
    project: CentralProject,
    assignment: Assignment,
    operation: "verify" | "head",
    write: () => Promise<R>,
  ): Promise<R> {
    const requested = performance.now();
    let entered: number | undefined;
    try {
      return await this.lock(
        {
          project_id: project.project_id,
          repository: this.central.repositoryPath(project),
          operation: "delivery.source",
        },
        () => {
          entered = performance.now();
          return write();
        },
      );
    } finally {
      if (entered !== undefined) {
        const held_ms = Math.round(performance.now() - entered);
        try {
          this.options.onSourceLock?.({
            event: "delivery_source_lock",
            project_id: project.project_id,
            assignment_id: assignment.id,
            operation,
            wait_ms: Math.round(entered - requested),
            held_ms,
          });
        } catch {
          // A failing log never changes the answer.
        }
      }
    }
  }
  private worktreesFor(project: CentralProject, assignment: Assignment) {
    return this.workspaceServices(project, assignment).worktrees;
  }
  /** Shared source resolution for workspace, delivery, precheck and backup. */
  private workspaceServices(
    project: CentralProject,
    assignment: Assignment,
    sourceScope: "assignment" | "repository" = "assignment",
  ): {
    central: CentralRepositoryService;
    worktrees: GitWorktreeService;
    validateTarget?: (tx?: StoreTransactionContext) => void;
  } {
    const targets = this.options.targets;
    if (!targets) {
      if (assignment.machine_id !== "local")
        throw new Error("Worker target is not configured");
      return { central: this.central, worktrees: this.worktrees };
    }
    const resolveTarget = (tx?: StoreTransactionContext) =>
      sourceScope === "repository"
        ? targets.forRepository(
            project.project_id as ProjectId,
            assignment.machine_id,
            tx,
          )
        : targets.forWorkspace(project.project_id as ProjectId, assignment, tx);
    const execution = resolveTarget().execution;
    const validateTarget = (tx?: StoreTransactionContext) => {
      if (
        resolveTarget(tx).execution.target?.fingerprint !==
        execution.target?.fingerprint
      )
        throw new Error("Workspace target configuration changed");
    };
    const roots = gitRoots(execution, execution.dataDir);
    if (execution.mode !== "agent-ssh" || !execution.gitHelper) {
      if (assignment.machine_id !== "local")
        throw new Error("Worker Git helper is not configured");
      const workspace =
        execution.mode === "agent-ssh"
          ? agentWorkspace(async (command, args, timeout) => {
              validateTarget();
              return targets.captureFor(
                project.project_id as ProjectId,
                assignment,
                command,
                args,
                timeout,
              );
            })
          : undefined;
      const central = new CentralRepositoryService(
        new CentralGitTransport({
          dataDir: this.options.dataDir,
          ...(execution.mode === "agent-ssh"
            ? { agentRoot: execution.agentRoot }
            : {}),
        }),
        {
          dataDir: this.options.dataDir,
          validateSource: validateTarget,
          repositoriesRoot: roots.repositoriesRoot,
          ...(execution.mode === "agent-ssh"
            ? {
                uploadPack: async (repository: string) => {
                  validateTarget();
                  return this.options.uploadPack
                    ? this.options.uploadPack(repository, execution)
                    : agentUploadPack(execution, repository);
                },
              }
            : {}),
        },
      );
      return {
        central,
        validateTarget,
        worktrees: new GitWorktreeService(
          new LocalGitTransport("git", {}, workspace),
          central,
          {
            dataDir: this.options.dataDir,
            ...roots,
            machineId: assignment.machine_id,
            lock: this.lock,
          },
        ),
      };
    }
    const transport = new WorkerGitTransport(
      execution,
      project.project_id,
      assignment.id,
      { validateTarget },
    );
    const central = new CentralRepositoryService(this.transport, {
      dataDir: this.options.dataDir,
      validateSource: validateTarget,
      agentSource: async (source, machine_id) => {
        validateTarget();
        if (
          source.project_id !== project.project_id ||
          machine_id !== assignment.machine_id
        )
          throw new Error("Worker source target changed");
        const repository = transport.repository;
        const uploadPack = await withGitTimeout(
          "fetch",
          {},
          async (timeout_ms) =>
            workerGitPack(execution, {
              operation: "upload-pack",
              project: project.project_id,
              assignment: assignment.id,
              repository,
              source: `cardigan-central:${project.project_id}`,
              format: await this.transport.objectFormat(
                this.central.repositoryPath(project),
              ),
              timeout_ms,
            }),
        );
        validateTarget();
        return {
          address: {
            kind: "worker-remote",
            path: repository,
            root: execution.agentRoot,
            project_id: project.project_id,
            machine_id,
          },
          uploadPack,
        };
      },
    });
    return {
      central,
      validateTarget,
      worktrees: new GitWorktreeService(transport, central, {
        dataDir: this.options.dataDir,
        ...roots,
        machineId: assignment.machine_id,
        files: transport.files,
        lock: this.lock,
      }),
    };
  }
  async removeWorktree(
    input: RemoveWorktreeInput,
  ): Promise<RemoveWorktreeOutcome> {
    return this.worktreesFor(input.project, input.assignment).removeWorktree(
      input,
    );
  }
  async diffWorktree(input: {
    readonly project: CentralProject;
    readonly assignment: Assignment;
  }): Promise<WorktreeDiff> {
    return this.worktreesFor(input.project, input.assignment).diffWorktree(
      input,
    );
  }
  async listBuildCheckouts(
    project: CentralProject,
  ): Promise<readonly string[] | undefined> {
    if (await preparationBusy(this.options.dataDir)) return undefined;
    const { uow, changesSince } = this.options.store;
    const fingerprint = () => {
      const changes =
        uow && changesSince
          ? uow.read(() =>
              changesSince.call(
                this.options.store,
                project.project_id,
                ["runs", "deliveries", "assignments"],
                undefined,
              ),
            )
          : undefined;
      return JSON.stringify([
        this.buildEpochs.get(project.project_id) ?? 0,
        preparationRevision(this.options.dataDir, project.project_id),
        ...(changes
          ? [...changes.cursor.versions].sort()
          : [++this.missingBuildVersion]),
      ]);
    };
    const version = fingerprint(),
      cached = this.buildCache.get(project.project_id);
    if (
      cached?.fingerprint === version &&
      performance.now() - cached.at < this.buildCacheMs
    )
      return [...cached.owners];
    const pending = this.buildQueries.get(project.project_id);
    if (pending?.fingerprint === version) return pending.query;
    const query = withPreparationQueue(
      this.options.dataDir,
      project.project_id,
      () => this.worktrees.listBuildCheckouts(project.project_id),
      undefined,
      true,
    );
    this.buildQueries.set(project.project_id, { fingerprint: version, query });
    try {
      const owners = await query;
      if (fingerprint() === version)
        this.buildCache.set(project.project_id, {
          at: performance.now(),
          fingerprint: version,
          owners: [...owners],
        });
      return [...owners];
    } finally {
      if (this.buildQueries.get(project.project_id)?.query === query)
        this.buildQueries.delete(project.project_id);
    }
  }
  async listMachineDirectories(
    project: CentralProject,
    machine_id: string,
  ): Promise<MachineDirectories | undefined> {
    if (await preparationBusy(this.options.dataDir)) return undefined;
    const project_id = project.project_id as ProjectId;
    // The helper binds every request to one Assignment; listing the project
    // roots is allowed for any of them, removal only for the owner's leaf.
    const probe =
      machine_id === "local"
        ? undefined
        : this.options.store.uow?.read((tx) =>
            tx.assignments
              .list(project_id)
              .find((a) => a.machine_id === machine_id),
          );
    if (machine_id !== "local" && probe === undefined)
      return { builds: [], worktrees: [] };
    return withPreparationQueue(
      this.options.dataDir,
      project.project_id,
      async () => {
        const service =
          probe === undefined
            ? this.worktrees
            : this.workspaceServices(project, probe, "repository").worktrees;
        return {
          builds: await service.listBuildCheckouts(project.project_id),
          worktrees: await service.listWorktreeOwners(project.project_id),
        };
      },
      undefined,
      true,
    );
  }
  async removeBuildCheckout(input: {
    readonly project: CentralProject;
    readonly assignment_id: string;
    readonly idle: () => boolean;
  }): Promise<RemoveBuildOutcome> {
    this.invalidateBuilds(input.project.project_id);
    try {
      const assignment = this.options.store.uow?.read((tx) =>
        tx.assignments.get(
          input.project.project_id as ProjectId,
          input.assignment_id as Assignment["id"],
        ),
      );
      const service = assignment
        ? this.worktreesFor(input.project, assignment)
        : this.worktrees;
      return await service.removeBuildCheckout(input);
    } finally {
      this.invalidateBuilds(input.project.project_id);
    }
  }
}
