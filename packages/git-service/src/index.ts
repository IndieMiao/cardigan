import { join, resolve } from "node:path";
import type {
  Assignment,
  Card,
  GitWorktreePort,
  Role,
  WorkItem,
} from "@cardigan/domain";
import { parseId } from "@cardigan/domain";

import type { CentralRepositoryService, SourceSync } from "./central.js";

export {
  type CentralOptions,
  type CentralProject,
  CentralRepositoryService,
  type SourceSync,
} from "./central.js";

export interface WorktreePlacement {
  readonly worktree_path: string;
  readonly branch?: string;
  readonly base_sha: string;
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
}
/** Application policy; Git process/file IO is injected through the domain port. */
export class GitWorktreeService {
  private readonly repositories: string;
  private readonly worktrees: string;
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
    if (role.worktree === "none") return undefined;
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
    const readonly = role.worktree === "readonly";
    if (
      readonly &&
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(input.target_sha ?? "")
    )
      throw new Error("Readonly worktree requires a delivery commit SHA");
    const path = join(this.worktrees, input.project_id, a.id),
      repository = join(this.repositories, input.project_id);
    const branch = readonly ? undefined : `agent/${card.id}/${item.id}`;
    if (a.worktree_path && resolve(a.worktree_path) !== path)
      throw new Error("Assignment worktree root changed");
    if (a.branch && a.branch !== branch)
      throw new Error("Assignment branch changed");
    const project = {
      project_id: input.project_id,
      source_repo: input.source_repo,
      base_branch: card.base_branch,
    };
    const central = await this.central.ensureCentral(project);
    await this.git.ensureClone(central, repository);
    const existing = (await this.git.listWorktrees(repository)).find(
      (w) => w.path === path,
    );
    if (existing) {
      if (
        existing.branch !== branch ||
        (readonly &&
          existing.head.toLowerCase() !== input.target_sha?.toLowerCase())
      )
        throw new Error(
          "Existing worktree has a different branch or review target",
        );
      return {
        worktree_path: path,
        ...(branch ? { branch } : {}),
        base_sha: a.base_sha ?? existing.head,
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
      ...(source_sync ? { source_sync } : {}),
    };
  }
  isDirty(worktree_path: string): Promise<boolean> {
    return this.git.isDirty(worktree_path);
  }
}
