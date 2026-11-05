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

/** Host-only bare repository operations. Every ref write requires an expected old value. */
export interface GitCentralPort {
  objectFormat(repository: string): Promise<"sha1" | "sha256">;
  objectType(repository: string, sha: string): Promise<string | undefined>;
  countCommits(repository: string, base: string, head: string): Promise<number>;
  ensureBare(
    source: string,
    repository: string,
    baseline: string,
  ): Promise<void>;
  fetchRefs(
    repository: string,
    source: string,
    refspecs: readonly string[],
    uploadPack?: string,
  ): Promise<void>;
  readRef(repository: string, ref: string): Promise<string | undefined>;
  isAncestor(
    repository: string,
    ancestor: string,
    descendant: string,
  ): Promise<boolean>;
  compareAndSwapRef(
    repository: string,
    ref: string,
    sha: string,
    expected: string | null,
  ): Promise<void>;
}
