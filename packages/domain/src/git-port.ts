/** Local Git plumbing used by the worktree service; no process or filesystem IO here. */
export interface GitWorktree {
  readonly path: string;
  readonly head: string;
  readonly branch?: string;
}
export interface GitWorktreePort {
  ensureClone(source: string, directory: string): Promise<void>;
  fetch(repository: string, source: string): Promise<void>;
  resolveCommit(repository: string, ref: string): Promise<string>;
  listWorktrees(repository: string): Promise<readonly GitWorktree[]>;
  addWorktree(
    repository: string,
    path: string,
    head: string,
    branch?: string,
  ): Promise<void>;
  isDirty(path: string): Promise<boolean>;
}
