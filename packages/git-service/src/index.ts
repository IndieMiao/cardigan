export { collectRoleRuleInventory } from "./role-rule-inventory.js";

import {
  access,
  lstat,
  mkdir,
  readdir,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  Assignment,
  Card,
  Delivery,
  GitWorktree,
  GitWorktreePort,
  Role,
  WorkItem,
} from "@cardigan/domain";
import { parseId } from "@cardigan/domain";

export {
  attributeReviewChanges,
  type ReviewAttribution,
  type ReviewAttributionResult,
  type ReviewDiffRange,
} from "./review-attribution.js";

import type {
  CentralProject,
  CentralRepositoryService,
  SourceSync,
} from "./central.js";
import { defaultRepositoryLock, type RepositoryLock } from "./lock.js";
import {
  type ExecutorCheckState,
  type ReconcileFinding,
  reconcile as reconcileState,
  type WorktreeState,
} from "./reconcile.js";

export {
  type CentralOptions,
  type CentralProject,
  CentralRepositoryService,
  type MergeOutcome,
  type PreparedMerge,
  type SourceSync,
} from "./central.js";
export {
  defaultRepositoryLock,
  type RepositoryLock,
  type RepositoryLockKey,
  type RepositoryLockOptions,
  RepositoryLockTimeoutError,
  repositoryLock,
} from "./lock.js";
export {
  DEFAULT_CHECK_CLEANUP_GRACE_MS,
  type ExecutorCheckState,
  type ReconcileChecks,
  type ReconcileFinding,
  type ReconcileFindingKind,
  reconcile,
  reconcileExecutorChecks,
  type WorktreeState,
} from "./reconcile.js";

export interface WorktreePlacement {
  readonly worktree_path: string;
  readonly branch?: string;
  readonly base_sha: string;
  /** Current remote baseline; independent of the Assignment's original base. */
  readonly baseline?: { readonly ref: string; readonly sha: string };
  /** Present only when a new writable worktree synchronizes its baseline. */
  readonly source_sync?: SourceSync;
}
export interface EnsureWorktreeInput {
  readonly project_id: string;
  readonly source_repo: string;
  readonly assignment: Assignment;
  readonly role: Role;
  readonly card?: Card;
  readonly work_item?: WorkItem;
  /** The delivery commit being reviewed; required for a readonly worktree. */
  readonly target_sha?: string;
}
export interface WorktreeOptions {
  readonly dataDir?: string;
  readonly repositoriesRoot?: string;
  readonly worktreesRoot?: string;
  readonly checksRoot?: string;
  /** P2a-3: writable build checkouts of verifiers, `<root>/<project>/<A-n>`. */
  readonly buildsRoot?: string;
  /** Where force-clean patches are written; defaults to `<dataDir>/cleanup`. */
  readonly cleanupRoot?: string;
  /**
   * Serializes fetch and worktree changes on a project's shared base clone.
   * Defaults to an in-process queue; the host adds a cross-process flock.
   */
  readonly lock?: RepositoryLock;
}
/** What a cleanup decision or a `worktree diff` shows the human. */
export interface WorktreeChangeSummary {
  readonly worktree_path: string;
  readonly branch?: string;
  readonly head_sha: string;
  readonly tracked: readonly string[];
  readonly untracked: readonly string[];
  /** The branch tip is reachable from a ref of the central repository. */
  readonly reachable: boolean;
}
export interface WorktreeDiff extends WorktreeChangeSummary {
  /** `git diff HEAD`; untracked files are listed separately and not inlined. */
  readonly patch: string;
}
/**
 * P2a-3: a verifier's writable build checkout. It is a detached worktree of
 * the delivery commit under the builds root, separate from the readonly review
 * worktree; nothing in it is ever backed up, pulled or merged.
 */
export interface BuildCheckout {
  readonly path: string;
  readonly sha: string;
}
export type RemoveBuildOutcome =
  | { readonly status: "removed" | "already_removed" }
  /** The guard found the build still in use; nothing was touched. */
  | { readonly status: "in_use" };
export interface RemoveWorktreeInput {
  readonly project: CentralProject;
  readonly assignment: Assignment;
  readonly force: boolean;
}
export type RemoveWorktreeOutcome =
  | { readonly status: "already_removed" }
  | {
      readonly status: "removed";
      readonly head_sha: string;
      /** Present when a dirty worktree was force-cleaned. */
      readonly patch_path?: string;
    }
  | {
      readonly status: "needs_decision";
      readonly summary: WorktreeChangeSummary;
    };

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
/** Immediate subdirectories of `path`; a missing directory is an empty list. */
async function subdirectories(path: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name))
      .sort();
  } catch (error) {
    if (code(error) === "ENOENT") return [];
    throw error;
  }
}
/** A non-local merge-check executor; `list` runs over its SSH entry. */
export interface ExecutorCheckScanner {
  readonly name: string;
  /** Absolute POSIX path on the executor machine. */
  readonly agentRoot: string;
  /** Throws on any failure; must never report a failure as empty. */
  list(project_id: string): Promise<{
    readonly directories: readonly string[];
    readonly registered: readonly string[];
  }>;
}
/** Application policy; Git process/file IO is injected through the domain port. */
export class GitWorktreeService {
  private readonly repositories: string;
  private readonly worktrees: string;
  private readonly checks: string;
  private readonly builds: string;
  private readonly cleanup: string;
  private readonly lock: RepositoryLock;
  constructor(
    private readonly git: GitWorktreePort,
    private readonly central: CentralRepositoryService,
    options: WorktreeOptions = {},
  ) {
    const dataDir = options.dataDir ?? process.env.CARDIGAN_DATA_DIR ?? ".data";
    this.repositories = resolve(
      options.repositoriesRoot ?? join(dataDir, "agent", "repos"),
    );
    this.worktrees = resolve(
      options.worktreesRoot ?? join(dataDir, "agent", "worktrees"),
    );
    this.checks = resolve(
      options.checksRoot ?? join(dataDir, "agent", "checks"),
    );
    this.builds = resolve(
      options.buildsRoot ?? join(dataDir, "agent", "builds"),
    );
    this.cleanup = resolve(options.cleanupRoot ?? join(dataDir, "cleanup"));
    this.lock = options.lock ?? defaultRepositoryLock;
  }
  async ensureWorktree(
    input: EnsureWorktreeInput,
  ): Promise<WorktreePlacement | undefined> {
    const { assignment: a, role, card, work_item: item } = input;
    if (
      a.status !== "active" ||
      a.machine_id !== "local" ||
      a.role_id !== role.role_id ||
      a.role_version !== role.version
    )
      throw new Error(
        "Worktree requires an active local Assignment and its fixed Role version",
      );
    if (role.worktree === "none" || (card && !card.repo)) return undefined;
    if (
      !parseId("assignment", a.id).ok ||
      !/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(input.project_id)
    )
      throw new Error("Invalid project or Assignment path component");
    if (
      a.scope !== "work_item" ||
      !card ||
      !item ||
      card.project_id !== input.project_id ||
      item.id !== a.work_item_id ||
      item.card_id !== card.id ||
      item.assignment_id !== a.id ||
      !parseId("card", card.id).ok ||
      !parseId("work_item", item.id).ok
    )
      throw new Error(
        "Worktree must belong to the Assignment's card and work item",
      );
    if (!card.base_branch)
      throw new Error("Repository card requires a base branch");
    const readonly = role.worktree === "readonly";
    if (
      readonly &&
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(input.target_sha ?? "")
    )
      throw new Error("Readonly worktree requires a delivery commit SHA");
    const path = join(this.worktrees, input.project_id, a.id),
      repository = join(this.repositories, input.project_id);
    const branch = readonly ? undefined : `agent/${card.id}/${item.id}`;
    const baselineRef = `origin/${card.base_branch}`;
    if (a.worktree_path && resolve(a.worktree_path) !== path)
      throw new Error("Assignment worktree root changed");
    if (a.branch && a.branch !== branch)
      throw new Error("Assignment branch changed");
    const project = {
      project_id: input.project_id,
      source_repo: input.source_repo,
      base_branch: card.base_branch,
    };
    return this.lock({ project_id: input.project_id, repository }, () =>
      this.placeWorktree(input, project, {
        path,
        repository,
        readonly,
        baselineRef,
        ...(branch ? { branch } : {}),
      }),
    );
  }
  /** Runs under the project's repository lock; inputs are validated. */
  private async placeWorktree(
    input: EnsureWorktreeInput,
    project: CentralProject,
    target: {
      readonly path: string;
      readonly repository: string;
      readonly readonly: boolean;
      readonly baselineRef: string;
      readonly branch?: string;
    },
  ): Promise<WorktreePlacement> {
    const { path, repository, readonly, baselineRef, branch } = target,
      a = input.assignment,
      card = input.card as Card;
    const central = await this.central.ensureCentral(project);
    await this.git.ensureClone(central, repository);
    const existing = (await this.git.listWorktrees(repository)).find(
      (w) => w.path === path,
    );
    if (existing) {
      if (existing.branch !== branch)
        throw new Error(
          "Existing worktree has a different branch or review target",
        );
      if (
        readonly &&
        existing.head.toLowerCase() !== input.target_sha?.toLowerCase()
      ) {
        if ((await this.git.changes(path)).tracked.length > 0)
          throw new Error("Review worktree has uncommitted changes");
        await this.git.fetch(repository, central);
        const target = await this.git.resolveCommit(
          repository,
          input.target_sha as string,
        );
        await this.git.checkoutDetached(path, target);
      }
      // Refresh the shared clone before every writer Run without touching its
      // branch, original base or uncommitted work. Agent mode pushes from host.
      let baseline: WorktreePlacement["baseline"];
      if (!readonly) {
        await this.git.fetch(repository, central);
        baseline = {
          ref: baselineRef,
          sha: await this.git.resolveCommit(
            repository,
            `refs/remotes/${baselineRef}`,
          ),
        };
      }
      return {
        worktree_path: path,
        ...(branch ? { branch } : {}),
        base_sha: a.base_sha ?? existing.head,
        ...(baseline ? { baseline } : {}),
      };
    }
    const source_sync = readonly
      ? undefined
      : await this.central.syncFromSource(project);
    await this.git.fetch(repository, central);
    const base_sha = await this.git.resolveCommit(
      repository,
      readonly
        ? (input.target_sha as string)
        : `refs/remotes/origin/${card.base_branch}`,
    );
    await this.git.addWorktree(repository, path, base_sha, branch);
    return {
      worktree_path: path,
      ...(branch ? { branch } : {}),
      base_sha,
      ...(!readonly ? { baseline: { ref: baselineRef, sha: base_sha } } : {}),
      ...(source_sync ? { source_sync } : {}),
    };
  }
  /** P2a-3: the only path a build checkout of this Assignment may use. */
  buildPath(project_id: string, assignment_id: string): string {
    if (
      !/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(project_id) ||
      !parseId("assignment", assignment_id).ok
    )
      throw new Error("Invalid project or Assignment path component");
    return join(this.builds, project_id, assignment_id);
  }

  /**
   * P2a-3: give a readonly verifier a writable, detached checkout of the
   * delivery it verifies. Every preparation starts from a fresh checkout: a
   * previous Run's checkout (even at the same commit) may hold edited,
   * staged or untracked sources and stale build outputs, so it is force
   * removed first — including a registration whose directory vanished. The
   * Dispatcher prepares once per Run, before the bell, so this never pulls a
   * directory from under a running verifier. Only `git worktree add
   * --detach` is used: no branch is created; the central repository is read.
   */
  async ensureBuildCheckout(
    input: EnsureWorktreeInput,
  ): Promise<BuildCheckout | undefined> {
    const { assignment: a, role, card, work_item: item } = input;
    if (role.worktree !== "readonly" || !card?.repo) return undefined;
    if (
      a.status !== "active" ||
      a.machine_id !== "local" ||
      a.scope !== "work_item" ||
      a.role_id !== role.role_id ||
      a.role_version !== role.version ||
      item?.kind !== "verify" ||
      item.id !== a.work_item_id ||
      item.card_id !== card.id ||
      item.assignment_id !== a.id ||
      card.project_id !== input.project_id ||
      !card.base_branch
    )
      throw new Error(
        "Build checkout requires an active local verification Assignment of a repository card",
      );
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(input.target_sha ?? ""))
      throw new Error("Build checkout requires a delivery commit SHA");
    const path = this.buildPath(input.project_id, a.id),
      repository = join(this.repositories, input.project_id),
      project = {
        project_id: input.project_id,
        source_repo: input.source_repo,
        base_branch: card.base_branch,
      };
    return this.lock({ project_id: input.project_id, repository }, async () => {
      const central = await this.central.ensureCentral(project);
      await this.git.ensureClone(central, repository);
      await this.git.fetch(repository, central);
      const sha = await this.git.resolveCommit(
        repository,
        input.target_sha as string,
      );
      const registered = (await this.git.listWorktrees(repository)).some(
        (w) => resolve(w.path) === path,
      );
      if (registered) await this.dropBuild(repository, path);
      else
        await this.pruneBuild(path).catch((error) => {
          throw new Error(
            `Build checkout ${path} has unregistered leftover contents (${code(error) ?? "unknown"}); remove it before the next Run`,
          );
        });
      await this.git.addWorktree(repository, path, sha);
      return { path, sha };
    });
  }

  /** Assignments with a build checkout directory or a Git registration. */
  async listBuildCheckouts(project_id: string): Promise<readonly string[]> {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(project_id))
      throw new Error("Invalid project path component");
    const root = join(this.builds, project_id),
      repository = join(this.repositories, project_id);
    const found = new Set(
      (await subdirectories(root)).map((path) => basename(path)),
    );
    // A registration whose directory vanished is a cleanup candidate as well.
    const hasClone = await access(repository).then(
      () => true,
      () => false,
    );
    if (hasClone)
      for (const entry of await this.git.listWorktrees(repository))
        if (dirname(resolve(entry.path)) === root)
          found.add(basename(entry.path));
    return [...found].filter((name) => parseId("assignment", name).ok).sort();
  }

  /**
   * P2a-3: remove a build checkout without asking — it holds no work. `idle`
   * is re-evaluated under the repository lock, after any concurrent
   * preparation finished, so a Run that just started keeps its checkout.
   */
  async removeBuildCheckout(input: {
    readonly project: CentralProject;
    readonly assignment_id: string;
    readonly idle: () => boolean;
  }): Promise<RemoveBuildOutcome> {
    const path = this.buildPath(input.project.project_id, input.assignment_id),
      repository = join(this.repositories, input.project.project_id);
    return this.lock(
      { project_id: input.project.project_id, repository },
      async () => {
        if (!input.idle()) return { status: "in_use" };
        const registered =
          (await access(repository).then(
            () => true,
            () => false,
          )) &&
          (await this.git.listWorktrees(repository)).some(
            (w) => resolve(w.path) === path,
          );
        if (!registered) {
          // Never recurse into unregistered contents: only an empty leaf goes.
          const existed = await access(path).then(
            () => true,
            () => false,
          );
          await this.pruneBuild(path);
          return { status: existed ? "removed" : "already_removed" };
        }
        await this.dropBuild(repository, path);
        return { status: "removed" };
      },
    );
  }

  /** Force-remove a registered build worktree; the host only rmdirs leaves. */
  private async dropBuild(repository: string, path: string): Promise<void> {
    // C-211: the verifier's own untracked files (dependencies, Vite caches)
    // go first, through Git and only inside this checkout. `git worktree
    // remove` stops at the first entry it cannot delete yet still drops the
    // registration, leaving leftovers the host may not recurse into; a
    // failing clean keeps the registration, so the next round retries.
    const present = await access(path).then(
      () => true,
      () => false,
    );
    if (present) await this.git.cleanBuildCheckout(repository, path);
    try {
      await this.git.removeWorktree(repository, path, { force: true });
    } catch (error) {
      // Same as removeLocked: Agent Git cannot unlink the host-owned leaf.
      await rmdir(path).catch((e) => {
        if (code(e) !== "ENOENT") throw error;
      });
      if (
        (await this.git.listWorktrees(repository)).some(
          (w) => resolve(w.path) === path,
        )
      )
        await this.git.removeWorktree(repository, path, { force: true });
    }
    await this.pruneBuild(path);
  }
  private async pruneBuild(path: string): Promise<void> {
    await rmdir(path).catch((error) => {
      if (code(error) !== "ENOENT") throw error;
    });
  }

  isDirty(worktree_path: string): Promise<boolean> {
    return this.git.isDirty(worktree_path);
  }

  /** The worktree this service owns for the Assignment, or a rejection. */
  private worktreeOf(project_id: string, assignment: Assignment) {
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/u.test(project_id))
      throw new Error("Invalid project path component");
    if (
      !parseId("assignment", assignment.id).ok ||
      assignment.scope !== "work_item" ||
      !assignment.worktree_path ||
      !isAbsolute(assignment.worktree_path)
    )
      throw new Error(
        "Cleanup requires a work-item Assignment with an absolute worktree path",
      );
    const path = join(this.worktrees, project_id, assignment.id);
    if (resolve(assignment.worktree_path) !== path)
      throw new Error("Assignment worktree is outside its project root");
    return {
      path,
      branch: assignment.branch,
      repository: join(this.repositories, project_id),
    };
  }

  /** §3.6 step 1–2: back the branch up, then judge what a removal would lose. */
  private async changeSummary(
    project: CentralProject,
    assignment: Assignment,
  ): Promise<WorktreeChangeSummary> {
    const worktree = this.worktreeOf(project.project_id, assignment);
    // The backup fetch runs first: a commit that only exists in this worktree
    // must reach the central repository before anyone decides to delete it.
    await this.central.backupAgentBranches(project, "local");
    const registered = (await this.git.listWorktrees(worktree.repository)).find(
        (entry) => resolve(entry.path) === worktree.path,
      ),
      changes = await this.git.changes(worktree.path);
    if (registered === undefined)
      throw new Error("Worktree is not registered in the base clone");
    const head_sha = registered.head;
    return {
      worktree_path: worktree.path,
      ...(worktree.branch === undefined ? {} : { branch: worktree.branch }),
      head_sha,
      tracked: changes.tracked,
      // Managed readonly worktrees have no Assignment branch and are detached.
      // A writer that temporarily detaches still keeps its assigned branch.
      untracked:
        worktree.branch === undefined && registered.branch === undefined
          ? []
          : changes.untracked,
      reachable: await this.central.hasCommit(project, head_sha),
    };
  }

  /** `cardigan worktree diff <A-n>`: the summary plus the tracked diff. */
  async diffWorktree(input: {
    readonly project: CentralProject;
    readonly assignment: Assignment;
  }): Promise<WorktreeDiff> {
    const { repository } = this.worktreeOf(
      input.project.project_id,
      input.assignment,
    );
    return this.lock(
      { project_id: input.project.project_id, repository },
      async () => {
        const summary = await this.changeSummary(
          input.project,
          input.assignment,
        );
        return {
          ...summary,
          patch: await this.git.diffHead(summary.worktree_path),
        };
      },
    );
  }

  /**
   * §3.6: remove a worktree only when nothing would be lost, or when the caller
   * forced it. A forced removal writes the diff and the untracked list to the
   * host's cleanup directory (0600) before deleting anything.
   */
  async removeWorktree(
    input: RemoveWorktreeInput,
  ): Promise<RemoveWorktreeOutcome> {
    const worktree = this.worktreeOf(
      input.project.project_id,
      input.assignment,
    );
    return this.lock(
      {
        project_id: input.project.project_id,
        repository: worktree.repository,
      },
      () => this.removeLocked(input, worktree),
    );
  }
  private async removeLocked(
    input: RemoveWorktreeInput,
    worktree: ReturnType<GitWorktreeService["worktreeOf"]>,
  ): Promise<RemoveWorktreeOutcome> {
    if (
      !(await this.git.listWorktrees(worktree.repository)).some(
        (w) => resolve(w.path) === worktree.path,
      )
    ) {
      // A previous Git removal can leave a host-owned empty leaf. Never recurse
      // into unregistered contents or pretend to know the removed HEAD.
      await this.pruneEmpty(worktree.path);
      return { status: "already_removed" };
    }
    const summary = await this.changeSummary(input.project, input.assignment),
      dirty = summary.tracked.length + summary.untracked.length > 0;
    if (!input.force && (dirty || !summary.reachable))
      return { status: "needs_decision", summary };
    let patch_path: string | undefined;
    if (input.force && dirty) {
      const patch = await this.git.diffHead(summary.worktree_path);
      patch_path = await this.writePatch(
        input.project.project_id,
        input.assignment,
        summary,
        patch,
      );
    }
    // The decision is made here; Git must not veto it because of a dirty file.
    try {
      await this.git.removeWorktree(worktree.repository, worktree.path, {
        force: true,
      });
    } catch (error) {
      // Agent cannot unlink a leaf from its host-owned namespace parent. Only
      // complete a removal here if Git already emptied it; otherwise keep data.
      await rmdir(worktree.path).catch((e) => {
        if (code(e) !== "ENOENT") throw error;
      });
      if (
        (await this.git.listWorktrees(worktree.repository)).some(
          (w) => resolve(w.path) === worktree.path,
        )
      )
        await this.git.removeWorktree(worktree.repository, worktree.path, {
          force: true,
        });
    }
    if (worktree.branch !== undefined)
      await this.git.deleteBranch(worktree.repository, worktree.branch);
    await this.pruneEmpty(worktree.path);
    return {
      status: "removed",
      head_sha: summary.head_sha,
      ...(patch_path === undefined ? {} : { patch_path }),
    };
  }

  private async pruneEmpty(path: string): Promise<void> {
    await rmdir(path).catch((error) => {
      if (code(error) !== "ENOENT") throw error;
    });
    await rmdir(dirname(path)).catch((error) => {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(code(error) ?? ""))
        throw error;
    });
  }

  private async writePatch(
    project_id: string,
    assignment: Assignment,
    summary: WorktreeChangeSummary,
    patch: string,
  ): Promise<string> {
    const directory = join(this.cleanup, project_id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replaceAll(":", "-"),
      path = join(directory, `${assignment.id}-${stamp}.patch`),
      header = [
        `# project: ${project_id}`,
        `# assignment: ${assignment.id}`,
        `# branch: ${summary.branch ?? "(detached)"}`,
        `# head: ${summary.head_sha}`,
        "# untracked files:",
        ...summary.untracked.map((name) => `#   ${name}`),
        "",
      ].join("\n");
    await writeFile(path, `${header}${patch}`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return path;
  }

  /** §3.6: gather the facts `reconcile` needs; this method never deletes. */
  async listWorktreeState(project: CentralProject): Promise<WorktreeState> {
    const root = join(this.worktrees, project.project_id),
      checksRoot = join(this.checks, project.project_id),
      buildsRoot = join(this.builds, project.project_id),
      clone = join(this.repositories, project.project_id),
      hasClone = await access(clone).then(
        () => true,
        () => false,
      ),
      [registered, directories, checkAttempts, builds, clones, central] =
        await Promise.all([
          // The base clone is itself a worktree; only linked worktrees belong
          // in the state, including checks outside the Assignment root.
          hasClone
            ? this.git
                .listWorktrees(clone)
                .then((entries) =>
                  entries.filter((entry) => resolve(entry.path) !== clone),
                )
            : Promise.resolve([] as readonly GitWorktree[]),
          subdirectories(root),
          subdirectories(checksRoot),
          subdirectories(buildsRoot),
          subdirectories(this.repositories),
          this.central.hasCentral(project),
        ]);
    // Git lists checks outside the Assignment root as well. Probe each path;
    // absence from a root listing is not evidence that its directory is gone.
    const candidates = new Set([
      ...directories,
      ...checkAttempts.map((attempt) => join(attempt, "worktree")),
      ...builds,
      ...registered.map((entry) => entry.path),
    ]);
    const existing = await Promise.all(
      [...candidates].map(async (path) => {
        try {
          return (await lstat(path)).isDirectory() ? path : undefined;
        } catch (error) {
          if (code(error) === "ENOENT") return undefined;
          throw error;
        }
      }),
    );
    const state: WorktreeState = {
      project_id: project.project_id,
      worktrees_root: root,
      checks_root: checksRoot,
      builds_root: buildsRoot,
      registered,
      directories: existing.filter(
        (path): path is string => path !== undefined,
      ),
      failed_clones: clones.filter((path) =>
        basename(path).startsWith(".clone-"),
      ),
      pinned: [],
    };
    if (!central) return state;
    const { pinned, source_sync } =
      await this.central.reconciliationState(project);
    return {
      ...state,
      source_sync,
      pinned: [...pinned].map(([delivery_id, sha]) => ({ delivery_id, sha })),
    };
  }

  /**
   * P2a-12 C: a non-local merge-check executor's check directories. The host
   * cannot read that disk, so the injected SSH listing replaces `readdir`;
   * any listing failure becomes `unreachable`, never an empty directory.
   */
  async listExecutorChecks(
    project: CentralProject,
    executor: ExecutorCheckScanner,
  ): Promise<ExecutorCheckState> {
    const checks_root = `${executor.agentRoot}/checks/${project.project_id}`;
    try {
      const listing = await executor.list(project.project_id);
      return {
        executor: executor.name,
        checks_root,
        listing: { status: "listed", ...listing },
      };
    } catch {
      return {
        executor: executor.name,
        checks_root,
        listing: { status: "unreachable" },
      };
    }
  }

  /** Gather the state and run the pure `reconcile` (report only, never delete). */
  async reconcile(
    project: CentralProject,
    assignments: readonly Assignment[],
    deliveries: readonly Delivery[],
  ): Promise<readonly ReconcileFinding[]> {
    return reconcileState(
      await this.listWorktreeState(project),
      assignments,
      deliveries,
    );
  }
}

export { GitDeliveryVerifier } from "./delivery.js";
