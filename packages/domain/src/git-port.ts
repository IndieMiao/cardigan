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
  /**
   * C-211: delete untracked and ignored files of a registered build checkout
   * (`git clean -ffdx` at its top level), never of a write worktree. Runs
   * before the removal so a file Git cannot delete fails here, while the
   * checkout is still registered and the removal can be retried.
   */
  cleanBuildCheckout(repository: string, path: string): Promise<void>;
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

/** The host checks authorization and runs this synchronous mutation under its write lock. */
export type GitPublicationGuard = (publish: () => void) => boolean;

/** Host-only bare repository operations. Every ref write requires an expected old value. */
export interface GitFileDiff {
  readonly path: string;
  readonly old_mode: string;
  readonly new_mode: string;
  readonly old_oid: string;
  readonly new_oid: string;
  readonly status: string;
  /** Zero-context patch, never an external diff or a text conversion. */
  readonly patch: string;
  /** Unconverted blob text for regular files; absent for links/submodules. */
  readonly before?: string;
  readonly after?: string;
}
export interface GitCentralPort {
  /** Full raw inventory; renames are delete + add, including mode-only changes. */
  fileDiffs?(
    repository: string,
    base: string,
    head: string,
  ): Promise<readonly GitFileDiff[]>;
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
    /** Polling only: skip transfer when all advertised refs already match. */
    skipIfUnchanged?: boolean,
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
    /** After all async preparation; false refuses the ref write. */
    guard?: GitPublicationGuard,
    // biome-ignore lint/suspicious/noConfusingVoidType: Existing adapters return void; false is a guarded refusal.
  ): Promise<void | false>;
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

/** C-308: reads from host-fixed center objects, never from an Agent checkout. */
export interface GitReviewAttributionPort
  extends Pick<GitCentralPort, "treeOfCommit" | "isAncestor" | "mergeTree"> {
  commitParents(repository: string, sha: string): Promise<readonly string[]>;
  changedPaths(
    repository: string,
    base: string,
    head: string,
  ): Promise<readonly string[]>;
  listTree(
    repository: string,
    commit: string,
    directory: string,
  ): Promise<
    readonly {
      readonly path: string;
      readonly mode: string;
      readonly type: string;
      readonly oid: string;
    }[]
  >;
}
