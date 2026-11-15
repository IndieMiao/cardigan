import { join, resolve } from "node:path";
import type {
  Assignment,
  Delivery,
  DeliveryId,
  DeliverySubject,
  DeliveryVerifier,
  MergePlan,
  MergePushCommit,
  ProjectId,
  SystemReviewLimitCandidate,
  SystemReviewLimitFailure,
  SystemReviewLimitOutcome,
} from "@cardigan/domain";
import { validationFailed } from "@cardigan/domain";
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
  reconcile,
  reconcileExecutorChecks,
  type SourceSync,
  type WorktreeDiff,
} from "@cardigan/git-service";
import {
  CentralGitTransport,
  LocalGitTransport,
  type PushResult,
  type WorkspaceGit as WorkspaceGitPort,
} from "@cardigan/git-transport";
import {
  hostRepositoryLock,
  loadWorkspace,
  type MergePushConfig,
  preparationBusy,
  preparationRevision,
  proveSystemReviewLimit,
  systemReviewLimitFailure,
  validateMergePushConfig,
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
} from "@cardigan/runtime-herdr";
import type { ProjectRecord, Store } from "@cardigan/store";

/**
 * M4.4: the server's Git assembly.
 *
 * §20.2 keeps Git behind `domain` ports: this module is the one place that
 * binds the ports to the real transports for the MCP endpoint and the control
 * plane. It hands out one verifier per project (§12.3) and one worktree service
 * for all projects (paths are project-scoped).
 */
export interface ServerGitOptions {
  readonly buildCheckoutCacheMs?: number;
  readonly store: Pick<Store, "getProject" | "listProjects"> &
    Partial<Pick<Store, "uow" | "changesSince">>;
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
  readonly uploadPack?: (repository: string) => Promise<string>;
  readonly receivePack?: (
    repository: string,
    execution: AgentExecution,
  ) => Promise<string>;
  /**
   * P2a-12 C: the non-local merge-check executor of a project, if any. Its
   * check directories live on another machine and are listed over SSH.
   */
  readonly checkExecutor?: (project_id: string) => AgentExecution | undefined;
  /** Test seam for the SSH listing; production uses `agentListChecks`. */
  readonly listChecks?: (
    execution: AgentExecution,
    project_id: string,
  ) => Promise<AgentCheckListing>;
}

/** What the loops need; tests substitute a plain object. */
export interface MergeGit {
  proveReviewLimit?(
    project: ProjectId,
    candidate: SystemReviewLimitCandidate,
  ): Promise<SystemReviewLimitOutcome>;
  projectOf(project_id: ProjectId): CentralProject | undefined;
  sync(project: CentralProject): Promise<SourceSync>;
  merge(project: CentralProject, plan: MergePlan): Promise<MergeOutcome>;
  baseline?(project: CentralProject): Promise<string>;
  prepare?(project: CentralProject, plan: MergePlan): Promise<PreparedMerge>;
  publish?(
    project: CentralProject,
    completion: DeliveryId,
    candidate: Extract<PreparedMerge, { status: "candidate" }>,
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
export interface ReconcileGit {
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
export type GitPhases = MergeGit & ReconcileGit;

/**
 * Everything apps/server needs from Git in one object. Tests that only exercise
 * routing inject a stub; production always uses `ServerGit` (real Git).
 */
export interface GitBinding extends GitPhases {
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
    this.lock = hostRepositoryLock(options.dataDir);
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
    return new GitDeliveryVerifier(this.central, project);
  };

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
      return await proveSystemReviewLimit(
        this.transport,
        repository,
        project.base_branch,
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
  prepare(project: CentralProject, plan: MergePlan): Promise<PreparedMerge> {
    return this.central.prepareMerge(project, plan);
  }
  async publish(
    project: CentralProject,
    completion: DeliveryId,
    candidate: Extract<PreparedMerge, { status: "candidate" }>,
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
    );
    return result.status === "merged" ? { ...result, tree_sha: tree } : result;
  }
  /**
   * P2a-13 A1: paths changed from `base` to `commit`, read in the center only.
   * Both must be full commit SHAs; refs are refused (the transport checks).
   */
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
    await this.lock({ project_id: project.project_id, repository }, () =>
      this.transfer(execution, source, repository),
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
  async backup(project: CentralProject): Promise<void> {
    await this.central.backupAgentBranches(project, "local");
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
  async reconcile(
    project: CentralProject,
    assignments: readonly Assignment[],
    deliveries: readonly Delivery[],
    readChecks?: () => ReconcileChecks,
  ): Promise<readonly ReconcileFinding[]> {
    // The local scan (readdir) always runs: it covers the default execution.
    const state = await this.worktrees.listWorktreeState(project);
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
      ...(remote
        ? reconcileExecutorChecks(remote, project.project_id, checks)
        : []),
    ];
  }
  async removeWorktree(
    input: RemoveWorktreeInput,
  ): Promise<RemoveWorktreeOutcome> {
    return this.worktrees.removeWorktree(input);
  }
  async diffWorktree(input: {
    readonly project: CentralProject;
    readonly assignment: Assignment;
  }): Promise<WorktreeDiff> {
    return this.worktrees.diffWorktree(input);
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
  async removeBuildCheckout(input: {
    readonly project: CentralProject;
    readonly assignment_id: string;
    readonly idle: () => boolean;
  }): Promise<RemoveBuildOutcome> {
    this.invalidateBuilds(input.project.project_id);
    try {
      return await this.worktrees.removeBuildCheckout(input);
    } finally {
      this.invalidateBuilds(input.project.project_id);
    }
  }
}
