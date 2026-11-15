import type { GitReviewAttributionPort } from "@cardigan/domain";

export interface ReviewDiffRange {
  readonly base: string;
  readonly head: string;
  readonly files: readonly string[];
}
export interface ReviewAttribution {
  readonly old_sha: string;
  readonly new_sha: string;
  readonly baseline_sha: string;
  readonly old_tree: string;
  readonly new_tree: string;
  readonly baseline_tree: string;
  /** Chronological, including changes later reverted by another own commit. */
  readonly ranges: readonly ReviewDiffRange[];
  readonly files: readonly string[];
  readonly baseline_merges: readonly {
    readonly commit: string;
    readonly first_parent: string;
    readonly baseline_parent: string;
    readonly tree: string;
  }[];
}
export type ReviewAttributionResult =
  | { readonly status: "attributed"; readonly proof: ReviewAttribution }
  | {
      readonly status: "full_review";
      readonly reason:
        | "invalid_sha"
        | "history_not_supported"
        | "untrusted_merge"
        | "merge_not_equivalent"
        | "unsupported_entry"
        | "no_own_changes"
        | "git_read_failed";
    };
const fullSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const safePath = (path: string) =>
  !!path &&
  path.length <= 4096 &&
  ![...path].some(
    (c) => c.charCodeAt(0) < 0x20 || c === "\x7f" || c === "\\",
  ) &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/**
 * Git attribution only, NOT a test isolation proof or an exemption grant.
 * The host must supply fixed old/new delivery commits and its current center
 * baseline. No author-provided ref, path list or diff participates in attribution.
 */
export async function attributeReviewChanges(
  git: GitReviewAttributionPort,
  repository: string,
  input: Pick<ReviewAttribution, "old_sha" | "new_sha" | "baseline_sha">,
): Promise<ReviewAttributionResult> {
  const fail = (
    reason: Extract<
      ReviewAttributionResult,
      { status: "full_review" }
    >["reason"],
  ): ReviewAttributionResult => ({ status: "full_review", reason });
  // Keep the exact versions stable across asynchronous reads.
  const versions = {
    old_sha: input.old_sha,
    new_sha: input.new_sha,
    baseline_sha: input.baseline_sha,
  };
  if (
    !Object.values(versions).every(
      (sha) => typeof sha === "string" && fullSha.test(sha),
    ) ||
    new Set(Object.values(versions).map((sha) => sha.length)).size !== 1
  )
    return fail("invalid_sha");
  try {
    const old_tree = await git.treeOfCommit(repository, versions.old_sha);
    const new_tree = await git.treeOfCommit(repository, versions.new_sha);
    const baseline_tree = await git.treeOfCommit(
      repository,
      versions.baseline_sha,
    );
    const ranges: ReviewDiffRange[] = [];
    const baseline_merges: ReviewAttribution["baseline_merges"][number][] = [];
    let cursor = versions.new_sha;
    const visited = new Set<string>();
    while (cursor !== versions.old_sha) {
      // A bounded query is an optimization only; exceeding it fails closed.
      if (visited.size >= 1000 || visited.has(cursor))
        return fail("history_not_supported");
      visited.add(cursor);
      const parents = await git.commitParents(repository, cursor);
      const parent = parents[0];
      if (!parent || parents.length > 2) return fail("history_not_supported");
      if (parents.length === 2) {
        const side = parents[1] as string;
        if (!(await git.isAncestor(repository, side, versions.baseline_sha)))
          return fail("untrusted_merge");
        const merged = await git.mergeTree(repository, parent, side);
        if (
          merged.conflicts.length ||
          merged.tree !== (await git.treeOfCommit(repository, cursor))
        )
          return fail("merge_not_equivalent");
        baseline_merges.push({
          commit: cursor,
          first_parent: parent,
          baseline_parent: side,
          tree: merged.tree,
        });
      } else {
        const files = [
          ...new Set(await git.changedPaths(repository, parent, cursor)),
        ].sort();
        const directories = new Map<
          string,
          Awaited<ReturnType<GitReviewAttributionPort["listTree"]>>
        >();
        for (const path of files) {
          if (!safePath(path)) return fail("unsupported_entry");
          const directory = path.includes("/")
            ? path.slice(0, path.lastIndexOf("/"))
            : "";
          const entries = [];
          for (const commit of [parent, cursor]) {
            const key = `${commit}:${directory}`;
            let listed = directories.get(key);
            if (!listed) {
              listed = await git.listTree(repository, commit, directory);
              directories.set(key, listed);
            }
            entries.push(listed.find((e) => e.path === path));
          }
          // Renames are delete + add. Executables, symlinks, submodules and
          // mode/type changes cannot become invisible test modifications.
          if (
            entries.every((e) => !e) ||
            entries.some((e) => e && (e.mode !== "100644" || e.type !== "blob"))
          )
            return fail("unsupported_entry");
        }
        if (files.length) ranges.push({ base: parent, head: cursor, files });
      }
      cursor = parent;
    }
    if (!ranges.length) return fail("no_own_changes");
    return {
      status: "attributed",
      proof: {
        ...versions,
        old_tree,
        new_tree,
        baseline_tree,
        ranges: ranges.reverse(),
        files: [...new Set(ranges.flatMap((r) => r.files))].sort(),
        baseline_merges: baseline_merges.reverse(),
      },
    };
  } catch {
    return fail("git_read_failed");
  }
}
