import {
  fullGitSha,
  type SystemReviewLimitCandidate,
  type SystemReviewLimitGitPort,
  type SystemReviewLimitProof,
} from "@cardigan/domain";

/** Only the host supplies the protected central repository and its registered baseline. No workspace Git. */
export async function proveSystemReviewLimit(
  git: SystemReviewLimitGitPort,
  repository: string,
  baseBranch: string,
  candidate: SystemReviewLimitCandidate,
): Promise<SystemReviewLimitProof | null> {
  try {
    if (
      candidate.base_branch !== baseBranch ||
      !fullGitSha(candidate.previous_sha) ||
      !fullGitSha(candidate.delivery_sha)
    )
      return null;
    const baseline = `refs/heads/${baseBranch}`;
    const base = await git.readRef(repository, baseline);
    if (!base || !fullGitSha(base)) return null;
    if (
      (await git.readRef(
        repository,
        `refs/cardigan/deliveries/${candidate.previous_delivery_id}`,
      )) !== candidate.previous_sha ||
      (await git.readRef(
        repository,
        `refs/cardigan/deliveries/${candidate.delivery_id}`,
      )) !== candidate.delivery_sha
    )
      return null;
    // Require an actual forward baseline integration, not an unchanged resubmission.
    if (
      (await git.isAncestor(repository, base, candidate.previous_sha)) ||
      !(await git.isAncestor(repository, base, candidate.delivery_sha)) ||
      !(await git.isAncestor(
        repository,
        candidate.previous_sha,
        candidate.delivery_sha,
      ))
    )
      return null;
    const merged = await git.mergeTree(
      repository,
      candidate.previous_sha,
      base,
    );
    if (merged.conflicts.length) return null;
    const tree = await git.treeOfCommit(repository, candidate.delivery_sha);
    if (tree !== merged.tree) return null;
    const paths = [
      ...new Set([
        ...(await git.changedPaths(
          repository,
          candidate.previous_sha,
          candidate.delivery_sha,
        )),
        ...(await git.changedPaths(repository, base, candidate.delivery_sha)),
      ]),
    ].sort();
    if ((await git.readRef(repository, baseline)) !== base) return null;
    return {
      candidate,
      base_sha: base,
      merged_tree: merged.tree,
      delivery_tree: tree,
      changed_paths: paths,
    };
  } catch {
    // Missing objects, unsupported Git, unreadable paths and uncertain results never grant a round.
    return null;
  }
}
