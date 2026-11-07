import { access, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type GitCentralPort, type MergePlan, parseId } from "@cardigan/domain";
export interface CentralProject {
  readonly project_id: string;
  readonly source_repo: string;
  readonly base_branch: string;
}
export interface CentralOptions {
  readonly dataDir: string;
  readonly centralRoot?: string;
  readonly repositoriesRoot?: string;
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
export const DEFAULT_MERGE_IDENTITY = {
  name: "Cardigan",
  email: "cardigan@localhost",
} as const;
const fullSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const projectSegment = /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u;
/** Ref policy lives here; filesystem and Git execution stay behind the domain port. */
export class CentralRepositoryService {
  private readonly root: string;
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
  private async sourceSnapshot(project: CentralProject) {
    const repo = await this.ensureCentral(project),
      base = `refs/heads/${project.base_branch}`,
      source = `refs/cardigan/source/${project.base_branch}`;
    await this.git.fetchRefs(repo, project.source_repo, [`+${base}:${source}`]);
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
    const { repo, old, next } = await this.sourceSnapshot(project);
    return this.classify(repo, old, next);
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
    const repository = await this.ensureCentral(project),
      prefix = "refs/cardigan/deliveries/",
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
    if (plan.base_branch !== project.base_branch)
      throw new Error("Merge plan targets a different baseline branch");
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
      // Re-running a merge is a no-op, never a second merge commit.
      if (await this.git.isAncestor(repository, delivery.sha, head)) continue;
      const merged = await this.git.mergeTree(repository, head, delivery.sha);
      if (merged.conflicts.length > 0)
        return {
          status: "conflicted",
          delivery_id: delivery.delivery_id,
          files: merged.conflicts,
        };
      head = await this.git.commitTree(repository, {
        tree: merged.tree,
        parents: [head, delivery.sha],
        message: [
          `Merge ${plan.card_id}/${delivery.work_item_id} delivery ${delivery.delivery_id}`,
          "",
          plan.title,
        ].join("\n"),
        author: identity,
      });
    }
    if (head === previous) return { status: "noop", branch_sha: previous };
    try {
      await this.git.compareAndSwapRef(repository, base, head, previous);
    } catch (error) {
      // Only a moved baseline is `stale`; anything else is a real failure.
      if ((await this.git.readRef(repository, base)) !== previous)
        return { status: "stale" };
      throw error;
    }
    return { status: "merged", merge_sha: head, previous_sha: previous };
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
  async agentSource(project: CentralProject) {
    const path = this.agentRepositoryPath(project);
    return { path, uploadPack: await this.options.uploadPack?.(path) };
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
    if (machine_id !== "local")
      throw new Error("Only local machine backups are supported");
    // No base clone before the first worktree is normal. Only this missing
    // path is skipped: dangling links, permission and later Git/SSH errors fail.
    try {
      await lstat(this.agentRepositoryPath(project));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const repository = await this.ensureCentral(project),
      source = await this.agentSource(project);
    await this.git.fetchRefs(
      repository,
      source.path,
      [`+refs/heads/agent/*:refs/cardigan/backups/${machine_id}/agent/*`],
      source.uploadPack,
    );
  }
}
