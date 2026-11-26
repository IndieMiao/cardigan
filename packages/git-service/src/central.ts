import { access, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type GitCentralPort,
  type GitPublicationGuard,
  type GitRepositoryAddress,
  type MergeBatch,
  type MergeBatchMember,
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
  /** Recheck a host-selected target after asynchronous Git IO. */
  readonly validateSource?: () => void;
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
/** A plain branch name below refs/heads; never a full ref, revision or pattern. */
export function validCentralBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    value !== "@" &&
    !value.startsWith("-") &&
    !value.startsWith("refs/") &&
    !/[\s~^:?*[\\]/u.test(value) &&
    ![...value].some((c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) === 127) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith(".") &&
    value
      .split("/")
      .every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"))
  );
}
/**
 * The same central repository seen through one baseline branch. Cards choose
 * their own `base_branch`; merge candidates, checks and publication of that
 * card use this view. Only the branch must exist in the central repository.
 */
export function centralBranch(
  project: CentralProject,
  branch: string,
): CentralProject {
  if (!validCentralBranch(branch))
    throw new Error("Invalid card baseline branch name");
  return branch === project.base_branch
    ? project
    : { ...project, base_branch: branch };
}
const projectSegment = /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u;
/** Ref policy lives here; filesystem and Git execution stay behind the domain port. */
export class CentralRepositoryService {
  private readonly root: string;
  /** Keyed by repository and baseline branch. */
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
    const repository = await this.ensureRepository(project);
    if (
      !(await this.git.readRef(repository, `refs/heads/${project.base_branch}`))
    )
      throw new Error("Central baseline branch is missing");
    return repository;
  }
  /** The central repository; an existing one need not have this branch yet. */
  private async ensureRepository(project: CentralProject): Promise<string> {
    if (!projectSegment.test(project.project_id))
      throw new Error("Invalid project path component");
    const repository = this.repositoryPath(project);
    await this.git.ensureBare(
      project.source_repo,
      repository,
      `refs/heads/${project.base_branch}`,
    );
    return repository;
  }
  /** Fetch the source snapshot and classify it without moving the baseline. */
  private async sourceSnapshot(
    project: CentralProject,
    polling = false,
    repository?: string,
  ) {
    const snapshot = await this.sourceRefs(project, polling, repository);
    if (!snapshot.old)
      throw new Error("Baseline disappeared during synchronization");
    return { ...snapshot, old: snapshot.old };
  }
  private async sourceRefs(
    project: CentralProject,
    polling: boolean,
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
    if (!next) throw new Error("Baseline disappeared during synchronization");
    return { repo, base, old, next };
  }
  private async classify(repo: string, old: string, next: string) {
    if (old === next) return "up_to_date" as const;
    if (await this.git.isAncestor(repo, old, next))
      return "fast_forwarded" as const;
    return (await this.git.isAncestor(repo, next, old)) ? "ahead" : "diverged";
  }
  /**
   * Bring one baseline branch up to date from the source. A branch created in
   * the source after the central clone is created here like the initial
   * clone; a central-only branch (merged here, absent from the source) has
   * nothing to sync and is reported `ahead`. Missing on both sides, or any
   * other I/O failure, is an error.
   */
  async syncFromSource(project: CentralProject): Promise<SourceSync> {
    // The branch name becomes a fetch refspec: never a pattern or full ref.
    if (!validCentralBranch(project.base_branch))
      throw new Error("Invalid baseline branch name");
    const repo = await this.ensureRepository(project),
      base = `refs/heads/${project.base_branch}`;
    let snapshot: Awaited<ReturnType<typeof this.sourceRefs>>;
    try {
      snapshot = await this.sourceRefs(project, false, repo);
    } catch (error) {
      if (await this.sourceLacks(repo, project, base)) {
        if (await this.git.readRef(repo, base)) return "ahead";
        throw new Error(
          "Baseline branch is missing in both the central repository and the source",
        );
      }
      throw error;
    }
    const { old, next } = snapshot;
    if (!old) {
      await this.createRef(repo, base, next);
      return "fast_forwarded";
    }
    const status = await this.classify(repo, old, next);
    if (status === "fast_forwarded")
      await this.git.compareAndSwapRef(repo, base, next, old);
    return status;
  }
  /** Proven absence only: an unanswerable query is not treated as missing. */
  private async sourceLacks(
    repo: string,
    project: CentralProject,
    ref: string,
  ): Promise<boolean> {
    if (!this.git.sourceHasRef) return false;
    try {
      return !(await this.git.sourceHasRef(repo, project.source_repo, ref));
    } catch {
      return false;
    }
  }
  /**
   * The central repository with this baseline branch present; a branch the
   * source created after the central clone is created on first use.
   */
  async ensureBranch(project: CentralProject): Promise<string> {
    if (!validCentralBranch(project.base_branch))
      throw new Error("Invalid baseline branch name");
    const repository = await this.ensureRepository(project);
    if (
      !(await this.git.readRef(repository, `refs/heads/${project.base_branch}`))
    )
      await this.syncFromSource(project);
    return this.ensureCentral(project);
  }
  /** Read-only view of §3.2 for reconciliation: never moves the baseline. */
  async sourceStatus(project: CentralProject): Promise<SourceSync> {
    const { repo, old, next } = await this.sourceSnapshot(project, true);
    return this.classifySource(repo, project.base_branch, old, next);
  }
  private async classifySource(
    repo: string,
    branch: string,
    old: string,
    next: string,
  ) {
    const key = `${repo}\n${branch}`;
    const previous = this.sourceClassifications.get(key);
    if (previous?.old === old && previous.next === next) return previous.status;
    const status = await this.classify(repo, old, next);
    this.sourceClassifications.set(key, { old, next, status });
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
      source_sync: await this.classifySource(
        repo,
        project.base_branch,
        old,
        next,
      ),
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
    // Callers select the card's branch with `centralBranch`; this only
    // guards against publishing a plan through another branch's view.
    if (plan.base_branch !== project.base_branch)
      throw new Error(
        "Merge plan baseline does not match the selected central branch",
      );
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
  /** Stack approved plans without moving any baseline ref. */
  async prepareBatch(project: CentralProject, plans: readonly MergePlan[]) {
    const repository = await this.ensureCentral(project);
    const base = await this.git.readRef(
      repository,
      `refs/heads/${project.base_branch}`,
    );
    if (!base) throw new Error("Central baseline is missing");
    let head = base;
    const members: MergeBatchMember[] = [];
    const conflicts: {
      plan: MergePlan;
      delivery_id: string;
      files: readonly string[];
    }[] = [];
    const noops: MergePlan[] = [];
    for (const plan of plans) {
      if (plan.base_branch !== project.base_branch)
        throw new Error("A merge batch must share one baseline branch");
      let next = head;
      let conflict:
        | { delivery_id: string; files: readonly string[] }
        | undefined;
      for (const delivery of plan.deliveries) {
        if (
          !parseId("delivery", delivery.delivery_id).ok ||
          !fullSha.test(delivery.sha) ||
          (await this.git.readRef(
            repository,
            `refs/cardigan/deliveries/${delivery.delivery_id}`,
          )) !== delivery.sha
        )
          throw new Error("Unpinned batch delivery");
        const result = await this.mergeCandidate(
          repository,
          next,
          delivery.sha,
          `Merge ${plan.card_id} delivery ${delivery.delivery_id}`,
          this.options.identity ?? DEFAULT_MERGE_IDENTITY,
        );
        if (result.conflicts.length) {
          conflict = {
            delivery_id: delivery.delivery_id,
            files: result.conflicts,
          };
          break;
        }
        next = result.sha;
      }
      if (conflict) {
        // A conflict introduced only by an earlier member keeps its queue position.
        const own = await this.prepareMerge(project, plan);
        if (own.status === "conflicted")
          conflicts.push({
            plan,
            delivery_id: own.delivery_id,
            files: own.files,
          });
        continue;
      }
      if (next === head) {
        if ((await this.prepareMerge(project, plan)).status === "noop")
          noops.push(plan);
        continue;
      }
      // Collapse multiple product deliveries into one per-card merge commit.
      const tree = await this.git.treeOfCommit(repository, next);
      const merged = await this.git.commitTree(repository, {
        tree,
        parents: [...new Set([head, ...plan.deliveries.map((d) => d.sha)])],
        message: `Merge ${plan.card_id}: ${plan.title}`,
        author: this.options.identity ?? DEFAULT_MERGE_IDENTITY,
      });
      members.push({
        card_id: plan.card_id,
        completion_id: plan.completion_id,
        merge_sha: merged,
        tree_sha: tree,
      });
      head = merged;
    }
    return { base_sha: base, members, conflicts, noops };
  }
  async pinBatch(project: CentralProject, batch: MergeBatch) {
    if (!parseId("merge_batch", batch.id).ok || !fullSha.test(batch.final_sha))
      throw new Error("Invalid batch identity");
    const repository = await this.ensureCentral(project);
    let previous = batch.base_sha;
    for (const member of batch.members) {
      if (
        !fullSha.test(member.merge_sha) ||
        !fullSha.test(member.tree_sha) ||
        (await this.git.treeOfCommit(repository, member.merge_sha)) !==
          member.tree_sha ||
        !(await this.git.isAncestor(repository, previous, member.merge_sha))
      )
        throw new Error("Invalid batch chain");
      previous = member.merge_sha;
    }
    if (
      previous !== batch.final_sha ||
      batch.members.at(-1)?.tree_sha !== batch.final_tree_sha
    )
      throw new Error("Invalid batch final tree");
    const ref = `refs/cardigan/candidates/${batch.id}`;
    const old = await this.git.readRef(repository, ref);
    if (old && old !== batch.final_sha)
      throw new Error("Batch candidate cannot change");
    if (!old)
      await this.git.compareAndSwapRef(repository, ref, batch.final_sha, null);
  }
  /** Recovery precedes stale/noop checks; a published final commit may already be an ancestor. */
  async publishBatch(
    project: CentralProject,
    batch: MergeBatch,
  ): Promise<
    { status: "published" } | { status: "stale"; observed_base_sha: string }
  > {
    await this.pinBatch(project, batch);
    const repository = await this.ensureCentral(project);
    const ref = `refs/heads/${project.base_branch}`;
    const current = await this.git.readRef(repository, ref);
    if (!current) throw new Error("Central baseline is missing");
    if (await this.git.isAncestor(repository, batch.final_sha, current))
      return { status: "published" };
    if (current !== batch.base_sha)
      return { status: "stale", observed_base_sha: current };
    try {
      const changed = await this.git.compareAndSwapRef(
        repository,
        ref,
        batch.final_sha,
        batch.base_sha,
      );
      if (changed !== false) return { status: "published" };
    } catch (error) {
      if ((await this.git.readRef(repository, ref)) === batch.base_sha)
        throw error;
    }
    return this.publishBatch(project, batch);
  }
  /** The final preparation's merge, before any commit object; `undefined` when already merged. */
  private async resolvedMerge(repository: string, base: string, sha: string) {
    if (await this.git.isAncestor(repository, sha, base)) return undefined;
    const merged = await this.git.mergeTree(repository, base, sha);
    return merged.conflicts.length === 1 &&
      merged.conflicts[0] === "docs/development-plan.md" &&
      this.git.resolvePlanConflict
      ? this.git.resolvePlanConflict(repository, base, sha, merged)
      : merged;
  }
  /**
   * C-782: paths the final merge preparation would report as conflicted for a
   * delivered head on the current baseline. Only merge-tree objects are
   * written: no commit, ref, index, worktree or repository lock is involved.
   */
  async trialMerge(
    project: CentralProject,
    base: string,
    sha: string,
  ): Promise<readonly string[]> {
    if (![base, sha].every((value) => fullSha.test(value)))
      throw new Error("Trial merge requires full commit SHAs");
    const repository = await this.ensureCentral(project);
    return (await this.resolvedMerge(repository, base, sha))?.conflicts ?? [];
  }
  private async mergeCandidate(
    repository: string,
    base: string,
    sha: string,
    message: string,
    identity: { readonly name: string; readonly email: string },
  ) {
    const merged = await this.resolvedMerge(repository, base, sha);
    if (!merged) return { sha: base, conflicts: [] as readonly string[] };
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
  /**
   * C-611: the pinned delivery merged onto the current baseline, for a macOS
   * check. One candidate per delivery and baseline: while neither moves, every
   * rerun tests the same commit.
   */
  async prepareDeliveryCandidate(
    project: CentralProject,
    delivery: string,
    headSha: string,
  ) {
    if (!parseId("delivery", delivery).ok || !fullSha.test(headSha))
      throw new Error("Invalid macOS check candidate identity");
    const repository = await this.ensureCentral(project);
    if (
      (await this.git.readRef(
        repository,
        `refs/cardigan/deliveries/${delivery}`,
      )) !== headSha
    )
      throw new Error("Unpinned delivery HEAD");
    const base = await this.git.readRef(
      repository,
      `refs/heads/${project.base_branch}`,
    );
    if (!base) throw new Error("Missing baseline");
    // A delivery's pinned HEAD never changes, so delivery plus baseline names
    // exactly one merge; an existing ref is that candidate.
    const ref = `refs/cardigan/candidates/macos-${delivery}-${base}`;
    let candidate = await this.git.readRef(repository, ref);
    if (!candidate) {
      const merged = await this.mergeCandidate(
        repository,
        base,
        headSha,
        `macOS check ${delivery}`,
        this.options.identity ?? DEFAULT_MERGE_IDENTITY,
      );
      if (merged.conflicts.length) throw new PrecheckMergeConflict(base);
      candidate = merged.sha;
      await this.git.compareAndSwapRef(repository, ref, candidate, null);
    }
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
    this.validateSource();
    if (this.options.agentSource) {
      const source = await this.options.agentSource(project, machine_id);
      if (
        source.address.kind === "worker-remote"
          ? source.address.project_id !== project.project_id ||
            source.address.machine_id !== machine_id ||
            !source.uploadPack
          : machine_id !== "local"
      )
        throw new Error("Worker source binding mismatch");
      return source;
    }
    if (machine_id !== "local")
      throw new Error("Worker source is not configured");
    const path = this.agentRepositoryPath(project);
    return {
      address: { kind: "host-local" as const, path },
      uploadPack: await this.options.uploadPack?.(path),
    };
  }
  validateSource(): void {
    this.options.validateSource?.();
  }
  /**
   * C-728: resolve a no-merge card's start point in the central repository and
   * pin it at `refs/cardigan/candidates/start/<assignment>`, a prefix every
   * base clone already receives from the host (local fetch, Agent push, worker
   * helper), so the target machine never contacts a remote itself. A branch is
   * synced from the source like a card baseline (fast-forward only); a commit
   * missing in the central repository is looked up among the source's branches
   * and tags. The pin follows the latest resolution with compare-and-swap.
   */
  async pinStartPoint(
    project: CentralProject,
    start: string,
    assignment_id: string,
  ): Promise<string> {
    if (!parseId("assignment", assignment_id).ok)
      throw new Error("Invalid Assignment id");
    const repository = await this.ensureCentral(project);
    let sha: string | undefined;
    if (fullSha.test(start)) {
      const isCommit = async () =>
        (await this.git.objectType(repository, start)) === "commit";
      if (!(await isCommit()))
        await this.git.fetchRefs(repository, project.source_repo, [
          "+refs/heads/*:refs/cardigan/start-source/heads/*",
          "+refs/tags/*:refs/cardigan/start-source/tags/*",
        ]);
      if (
        start.length !==
          ((await this.git.objectFormat(repository)) === "sha1" ? 40 : 64) ||
        !(await isCommit())
      )
        throw new Error(
          `Start point commit ${start} is in neither the central repository nor the source`,
        );
      sha = start;
    } else {
      if (!validCentralBranch(start))
        throw new Error("Invalid start point branch name");
      try {
        await this.syncFromSource(centralBranch(project, start));
      } catch (error) {
        throw new Error(
          `Start point branch ${start} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      sha = await this.git.readRef(repository, `refs/heads/${start}`);
      if (!sha) throw new Error(`Start point branch ${start} is missing`);
    }
    const ref = `refs/cardigan/candidates/start/${assignment_id}`;
    const current = await this.git.readRef(repository, ref);
    if (current !== sha)
      await this.git.compareAndSwapRef(repository, ref, sha, current ?? null);
    return sha;
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
  /** Legacy local polling skips a base clone that does not exist yet. */
  async backupSource(project: CentralProject, machine_id: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(machine_id))
      throw new Error("Invalid backup machine");
    if (machine_id !== "local" && !this.options.agentSource)
      throw new Error("Worker source is not configured");
    const source = this.options.agentSource
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
    return source ?? this.agentSource(project, machine_id);
  }
  async backupAgentBranches(
    project: CentralProject,
    machine_id: string,
    excludedBranches: readonly string[] = [],
  ) {
    const source = await this.backupSource(project, machine_id);
    if (!source) return;
    const repository = await this.ensureCentral(project);
    const backup = await this.git.prepareBranchBackup(
      repository,
      source.address,
      {
        machine: machine_id,
        excludedBranches,
        ...(source.uploadPack ? { uploadPack: source.uploadPack } : {}),
        skipIfUnchanged: true,
      },
    );
    this.validateSource();
    backup.publish();
  }
}
