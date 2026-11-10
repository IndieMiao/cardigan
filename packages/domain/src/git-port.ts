/** Local Git plumbing used by the worktree service; no process or filesystem IO here. */
export interface GitWorktree {
  readonly path: string;
  readonly head: string;
  readonly branch?: string;
}
/** Changed paths of a worktree: tracked (modified or staged) and untracked. */
export interface GitWorktreeChanges {
  readonly tracked: readonly string[];
  readonly untracked: readonly string[];
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
  /** Retarget a clean detached review workspace; never force or discard edits. */
  checkoutDetached(path: string, head: string): Promise<void>;
  /** The cleanup decision needs the file lists, not just a boolean. */
  changes(path: string): Promise<GitWorktreeChanges>;
  /** `git diff HEAD`: staged and unstaged changes of tracked files. */
  diffHead(path: string): Promise<string>;
  removeWorktree(
    repository: string,
    path: string,
    options: { readonly force: boolean },
  ): Promise<void>;
  deleteBranch(repository: string, branch: string): Promise<void>;
}

/** In-memory result of `merge-tree --write-tree`; conflicts never move a ref. */
export interface GitTreeMerge {
  readonly tree: string;
  readonly conflicts: readonly string[];
}
export interface GitCommitTreeInput {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  /** Merge commits never inherit the host's Git identity. */
  readonly author: { readonly name: string; readonly email: string };
}
export interface GitRef {
  readonly ref: string;
  readonly sha: string;
}

/** Host-only bare repository operations. Every ref write requires an expected old value. */
export interface GitCentralPort {
  objectFormat(repository: string): Promise<"sha1" | "sha256">;
  objectType(repository: string, sha: string): Promise<string | undefined>;
  /** Read the tree of a full commit SHA, never of an arbitrary ref or tag. */
  treeOfCommit(repository: string, sha: string): Promise<string>;
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
  /** Merge two commits in the bare repository without checking anything out. */
  mergeTree(
    repository: string,
    ours: string,
    theirs: string,
  ): Promise<GitTreeMerge>;
  commitTree(repository: string, input: GitCommitTreeInput): Promise<string>;
  /** Whether the object is reachable from some ref, e.g. after a backup fetch. */
  isReachable(repository: string, sha: string): Promise<boolean>;
  listRefs(repository: string, prefix: string): Promise<readonly GitRef[]>;
}
