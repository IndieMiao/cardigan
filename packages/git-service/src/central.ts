import { access, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type GitCentralPort,
  type GitPublicationGuard,
  type GitRepositoryAddress,
  type MergePlan,
  parseId,
} from "@cardigan/domain";

export class PrecheckMergeConflict extends Error {
  constructor(readonly baseSha: string) {
    super("Precheck merge conflict");
  }
}

export interface CentralProject {
  readonly project_id: string;
  readonly source_repo: string;
  readonly base_branch: string;
}
export interface CentralOptions {
  readonly dataDir: string;
  readonly centralRoot?: string;
  readonly repositoriesRoot?: string;
  /** Trusted target factory; remote paths are opaque on the controller. */
  readonly agentSource?: (
    project: CentralProject,
    machine_id: string,
  ) => Promise<{
    readonly address: GitRepositoryAddress;
    readonly uploadPack?: string;
  }>;
  /** Host-supplied streaming entry; never an Agent-provided command. */
  readonly uploadPack?: (repository: string) => Promise<string>;
  /** Author and committer of merge commits; never the host's Git identity. */
  readonly identity?: { readonly name: string; readonly email: string };
}
export type SourceSync = "fast_forwarded" | "up_to_date" | "ahead" | "diverged";
/** §3.5: a conflict, a moved baseline or a no-op never fails the caller. */
export type MergeOutcome =
  | {
      readonly status: "merged";
      readonly merge_sha: string;
      readonly previous_sha: string;
    }
  | {
      readonly status: "conflicted";
      readonly delivery_id: string;
      readonly files: readonly string[];
    }
  | { readonly status: "stale" }
  | { readonly status: "noop"; readonly branch_sha: string };
export type PreparedMerge =
  | {
      readonly status: "candidate";
      readonly candidate_sha: string;
      readonly tree_sha: string;
      readonly previous_sha: string;
    }
  | Extract<MergeOutcome, { readonly status: "conflicted" | "noop" }>;
export const DEFAULT_MERGE_IDENTITY = {
  name: "Cardigan",
  email: "cardigan@localhost",
} as const;
const fullSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const projectSegment = /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u;
/** Ref policy lives here; filesystem and Git execution stay behind the domain port. */
export class CentralRepositoryService {
  private readonly root: string;
  private readonly sourceClassifications = new Map<
    string,
    {
      old: string;
      next: string;
      status: SourceSync;
    }
  >();
  constructor(
    readonly git: GitCentralPort,
    private readonly options: CentralOptions,
  ) {
    this.root = resolve(
      options.centralRoot ?? join(options.dataDir, "central"),
    );
  }
  /** The central repository path; reading it never creates it. */
  repositoryPath(project: CentralProject): string {
    if (!projectSegment.test(project.project_id))
      throw new Error("Invalid project path component");
    return join(this.root, `${project.project_id}.git`);
  }
  async hasCentral(project: CentralProject): Promise<boolean> {
    return access(this.repositoryPath(project)).then(
      () => true,
      () => false,
    );
  }
  async ensureCentral(project: CentralProject): Promise<string> {
    if (!projectSegment.test(project.project_id))
      throw new Error("Invalid project path component");
    const repository = this.repositoryPath(project);
    await this.git.ensureBare(
      project.source_repo,
      repository,
      `refs/heads/${project.base_branch}`,
    );
    if (
      !(await this.git.readRef(repository, `refs/heads/${project.base_branch}`))
    )
      throw new Error("Central baseline branch is missing");
    return repository;
  }
  /** Fetch the source snapshot and classify it without moving the baseline. */
  private async sourceSnapshot(
    project: CentralProject,
    polling = false,
    repository?: string,
  ) {
    const repo = repository ?? (await this.ensureCentral(project)),
      base = `refs/heads/${project.base_branch}`,
      source = `refs/cardigan/source/${project.base_branch}`;
    await this.git.fetchRefs(
      repo,
      project.source_repo,
      [`+${base}:${source}`],
      undefined,
      polling,
    );
    const old = await this.git.readRef(repo, base),
      next = await this.git.readRef(repo, source);
    if (!old || !next)
      throw new Error("Baseline disappeared during synchronization");
    return { repo, base, old, next };
  }
  private async classify(repo: string, old: string, next: string) {
    if (old === next) return "up_to_date" as const;
    if (await this.git.isAncestor(repo, old, next))
      return "fast_forwarded" as const;
    return (await this.git.isAncestor(repo, next, old)) ? "ahead" : "diverged";
  }
  async syncFromSource(project: CentralProject): Promise<SourceSync> {
    const { repo, base, old, next } = await this.sourceSnapshot(project);
    const status = await this.classify(repo, old, next);
    if (status === "fast_forwarded")
      await this.git.compareAndSwapRef(repo, base, next, old);
    return status;
  }
  /** Read-only view of §3.2 for reconciliation: never moves the baseline. */
  async sourceStatus(project: CentralProject): Promise<SourceSync> {
    const { repo, old, next } = await this.sourceSnapshot(project, true);
    return this.classifySource(repo, old, next);
  }
  private async classifySource(repo: string, old: string, next: string) {
    const previous = this.sourceClassifications.get(repo);
    if (previous?.old === old && previous.next === next) return previous.status;
    const status = await this.classify(repo, old, next);
    this.sourceClassifications.set(repo, { old, next, status });
    return status;
  }
  /** One validation per scan; still observe refs on disk on every poll. */
  async reconciliationState(project: CentralProject) {
    const repository = await this.ensureCentral(project);
    const { repo, old, next } = await this.sourceSnapshot(
      project,
      true,
      repository,
    );
    return {
      source_sync: await this.classifySource(repo, old, next),
      pinned: await this.readPinned(repository),
    };
  }
  /** Whether a commit is reachable from some ref of the central repository. */
  async hasCommit(project: CentralProject, sha: string): Promise<boolean> {
    if (!fullSha.test(sha)) throw new Error("Invalid full commit SHA");
    const repository = await this.ensureCentral(project);
    if ((await this.git.objectType(repository, sha)) !== "commit") return false;
    return this.git.isReachable(repository, sha);
  }
  /** Fixed delivery refs (`refs/cardigan/deliveries/<id>`) keyed by delivery id. */
  async pinnedDeliveries(
    project: CentralProject,
  ): Promise<ReadonlyMap<string, string>> {
    return this.readPinned(await this.ensureCentral(project));
  }
  private async readPinned(
    repository: string,
  ): Promise<ReadonlyMap<string, string>> {
    const prefix = "refs/cardigan/deliveries/",
      pinned = new Map<string, string>();
    for (const { ref, sha } of await this.git.listRefs(repository, prefix))
      pinned.set(ref.slice(prefix.length), sha);
    return pinned;
  }
  /**
   * §3.5: linearize the planned deliveries on the central baseline.
   *
   * Every merge happens in the bare repository (`merge-tree` + `commit-tree`),
   * so no filter, hook or smudge of any checked-out worktree runs. A conflict
   * returns before any ref moves; a baseline advanced by someone else returns
   * `stale` instead of overwriting it.
   */
  async mergeIntoBase(
    project: CentralProject,
    plan: MergePlan,
  ): Promise<MergeOutcome> {
    const prepared = await this.prepareMerge(project, plan);
    return prepared.status === "candidate"
      ? this.publishMerge(
          project,
          plan.completion_id,
          prepared.candidate_sha,
          prepared.previous_sha,
        )
      : prepared;
  }
  /** Build and pin a candidate in the bare repository without advancing the baseline. */
  async prepareMerge(
    project: CentralProject,
    plan: MergePlan,
  ): Promise<PreparedMerge> {
    if (plan.base_branch !== project.base_branch)
      throw new Error("Merge plan targets a different baseline branch");
    if (!parseId("delivery", plan.completion_id).ok)
      throw new Error("Invalid completion id in the merge plan");
    const repository = await this.ensureCentral(project),
      base = `refs/heads/${project.base_branch}`,
      previous = await this.git.readRef(repository, base);
    if (!previous) throw new Error("Central baseline branch is missing");
    const identity = this.options.identity ?? DEFAULT_MERGE_IDENTITY;
    let head = previous;
    for (const delivery of plan.deliveries) {
      if (!parseId("delivery", delivery.delivery_id).ok)
        throw new Error("Invalid delivery id in the merge plan");
      if (!fullSha.test(delivery.sha))
        throw new Error("Invalid delivery SHA in the merge plan");
      const pinned = await this.git.readRef(
        repository,
        `refs/cardigan/deliveries/${delivery.delivery_id}`,
      );
      if (pinned !== delivery.sha)
        throw new Error(
          `Delivery ${delivery.delivery_id} is not pinned to the planned SHA`,
        );
      const merged = await this.mergeCandidate(
        repository,
        head,
        delivery.sha,
        [
          `Merge ${plan.card_id}/${delivery.work_item_id} delivery ${delivery.delivery_id}`,
          "",
          plan.title,
        ].join("\n"),
        identity,
      );
      if (merged.conflicts.length)
        return {
          status: "conflicted",
          delivery_id: delivery.delivery_id,
          files: merged.conflicts,
        };
      head = merged.sha;
    }
    if (head === previous) return { status: "noop", branch_sha: previous };
    const tree = await this.git.treeOfCommit(repository, head);
    const ref = `refs/cardigan/candidates/${plan.completion_id}`;
    const old = await this.git.readRef(repository, ref);
    if (old !== head)
      await this.git.compareAndSwapRef(repository, ref, head, old ?? null);
    return {
      status: "candidate",
      candidate_sha: head,
      tree_sha: tree,
      previous_sha: previous,
    };
  }
  private async mergeCandidate(
    repository: string,
    base: string,
    sha: string,
    message: string,
    identity: { readonly name: string; readonly email: string },
  ) {
    if (await this.git.isAncestor(repository, sha, base))
      return { sha: base, conflicts: [] as readonly string[] };
    let merged = await this.git.mergeTree(repository, base, sha);
    if (
      merged.conflicts.length === 1 &&
      merged.conflicts[0] === "docs/development-plan.md" &&
      this.git.resolvePlanConflict
    )
      merged = await this.git.resolvePlanConflict(
        repository,
        base,
        sha,
        merged,
      );
    if (merged.conflicts.length)
      return { sha: base, conflicts: merged.conflicts };
    return {
      sha: await this.git.commitTree(repository, {
        tree: merged.tree,
        parents: [base, sha],
        message,
        author: identity,
      }),
      conflicts: [] as readonly string[],
    };
  }
  /** Same merge-tree/commit-tree candidate construction as final preparation; never publishes. */
  async preparePrecheck(
    project: CentralProject,
    assignment: string,
    headSha: string,
    attempt: string,
  ) {
    if (
      !parseId("assignment", assignment).ok ||
      !fullSha.test(headSha) ||
      !/^[A-Za-z0-9_-]{1,80}$/u.test(attempt)
    )
      throw new Error("Invalid precheck candidate identity");
    const repository = await this.ensureCentral(project);
    if (
      (await this.git.readRef(
        repository,
        `refs/cardigan/prechecks/${assignment}/${headSha}`,
      )) !== headSha
    )
      throw new Error("Unpinned precheck HEAD");
    const base = await this.git.readRef(
      repository,
      `refs/heads/${project.base_branch}`,
    );
    if (!base) throw new Error("Missing baseline");
    const merged = await this.mergeCandidate(
      repository,
      base,
      headSha,
      `Precheck ${assignment} ${attempt}`,
      this.options.identity ?? DEFAULT_MERGE_IDENTITY,
    );
    if (merged.conflicts.length) throw new PrecheckMergeConflict(base);
    const candidate = merged.sha;
    const ref = `refs/cardigan/candidates/precheck-${attempt}`;
    const old = await this.git.readRef(repository, ref);
    if (old !== candidate)
      await this.git.compareAndSwapRef(repository, ref, candidate, old ?? null);
    return {
      candidate_sha: candidate,
      tree_sha: await this.git.treeOfCommit(repository, candidate),
      base_sha: base,
    };
  }
  /** Publish only by CAS, after the caller has checked this exact candidate tree. */
  async publishMerge(
    project: CentralProject,
    completion_id: string,
    candidate_sha: string,
    previous_sha: string,
    guard?: GitPublicationGuard,
  ): Promise<Extract<MergeOutcome, { status: "merged" | "stale" }>> {
    if (
      ![candidate_sha, previous_sha].every((sha) => fullSha.test(sha)) ||
      candidate_sha.length !== previous_sha.length
    )
      throw new Error("Publishing requires full candidate and baseline SHAs");
    if (!parseId("delivery", completion_id).ok)
      throw new Error("Invalid completion id for publication");
    const repository = await this.ensureCentral(project),
      base = `refs/heads/${project.base_branch}`;
    if (
      (await this.git.readRef(
        repository,
        `refs/cardigan/candidates/${completion_id}`,
      )) !== candidate_sha
    )
      throw new Error("Candidate ref does not match the prepared completion");
    if (
      (await this.git.objectType(repository, candidate_sha)) !== "commit" ||
      (await this.git.objectType(repository, previous_sha)) !== "commit" ||
      !(await this.git.isAncestor(repository, previous_sha, candidate_sha))
    )
      throw new Error(
        "Candidate must be a commit descending from the prepared baseline",
      );
    try {
      const published = await this.git.compareAndSwapRef(
        repository,
        base,
        candidate_sha,
        previous_sha,
        guard,
      );
      if (published === false) return { status: "stale" };
    } catch (error) {
      // Only a moved baseline is `stale`; anything else is a real failure.
      if ((await this.git.readRef(repository, base)) !== previous_sha)
        return { status: "stale" };
      throw error;
    }
    return { status: "merged", merge_sha: candidate_sha, previous_sha };
  }
  private agentRepositoryPath(project: CentralProject): string {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(project.project_id))
      throw new Error("Invalid project path component");
    return resolve(
      this.options.repositoriesRoot ??
        join(this.options.dataDir, "agent", "repos"),
      project.project_id,
    );
  }
  async agentSource(project: CentralProject, machine_id = "local") {
    if (this.options.agentSource)
      return this.options.agentSource(project, machine_id);
    if (machine_id !== "local")
      throw new Error("Worker source is not configured");
    const path = this.agentRepositoryPath(project);
    return {
      address: { kind: "host-local" as const, path },
      uploadPack: await this.options.uploadPack?.(path),
    };
  }
  /** Only creates; same SHA is an idempotent success, including concurrent creation. */
  async createRef(repository: string, ref: string, sha: string) {
    const current = await this.git.readRef(repository, ref);
    if (current === sha) return;
    if (current)
      throw new Error("Immutable ref already points to a different SHA");
    try {
      await this.git.compareAndSwapRef(repository, ref, sha, null);
    } catch (error) {
      if ((await this.git.readRef(repository, ref)) !== sha) throw error;
    }
  }
  async pinDelivery(project: CentralProject, delivery_id: string, sha: string) {
    if (
      !parseId("delivery", delivery_id).ok ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha)
    )
      throw new Error("Invalid delivery id or SHA");
    const repository = await this.ensureCentral(project);
    if (
      sha.length !==
        ((await this.git.objectFormat(repository)) === "sha1" ? 40 : 64) ||
      (await this.git.objectType(repository, sha)) !== "commit"
    )
      throw new Error("Delivery SHA is not a full commit id");
    await this.createRef(
      repository,
      `refs/cardigan/deliveries/${delivery_id}`,
      sha,
    );
  }
  async backupAgentBranches(project: CentralProject, machine_id: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(machine_id))
      throw new Error("Invalid backup machine");
    if (machine_id !== "local" && !this.options.agentSource)
      throw new Error("Worker source is not configured");
    let source = this.options.agentSource
      ? await this.agentSource(project, machine_id)
      : undefined;
    // No base clone before the first worktree is normal. Only this missing
    // path is skipped: dangling links, permission and later Git/SSH errors fail.
    try {
      if (!source || source.address.kind === "host-local")
        await lstat(source?.address.path ?? this.agentRepositoryPath(project));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    source ??= await this.agentSource(project, machine_id);
    const repository = await this.ensureCentral(project);
    await this.git.fetchRefs(
      repository,
      source.address,
      [`+refs/heads/agent/*:refs/cardigan/backups/${machine_id}/agent/*`],
      source.uploadPack,
      true,
    );
  }
}
