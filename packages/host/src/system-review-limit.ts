import {
  fullGitSha,
  type SystemReviewLimitCandidate,
  type SystemReviewLimitFailure,
  type SystemReviewLimitGitPort,
  type SystemReviewLimitOutcome,
} from "@cardigan/domain";

/** Inspect raw errors only in memory; the result contains two allowlisted labels. */
export function systemReviewLimitFailure(
  error: unknown,
  stage: SystemReviewLimitFailure["stage"],
): { failure: SystemReviewLimitFailure } {
  const e = (error && typeof error === "object" ? error : {}) as {
    code?: unknown;
    message?: unknown;
    stderr?: unknown;
    killed?: unknown;
  };
  const text = [e.message, e.stderr]
    .filter((v) => typeof v === "string")
    .join("\n");
  const category: SystemReviewLimitFailure["category"] =
    e.code === "EACCES" ||
    e.code === "EPERM" ||
    /permission denied|operation not permitted/iu.test(text)
      ? "access_denied"
      : e.code === "ETIMEDOUT" ||
          e.killed === true ||
          /timed out|timeout/iu.test(text)
        ? "timeout"
        : /unknown option|unrecognized option|not a git command|unsupported/iu.test(
              text,
            )
          ? "unsupported_git"
          : e.code === "ENOENT"
            ? "unavailable"
            : typeof e.code === "number"
              ? "git_error"
              : "unexpected_error";
  return { failure: { stage, category } };
}

/** Only the host supplies the protected central repository and its registered baseline. No workspace Git. */
export async function proveSystemReviewLimit(
  git: SystemReviewLimitGitPort,
  repository: string,
  baseBranch: string,
  candidate: SystemReviewLimitCandidate,
): Promise<SystemReviewLimitOutcome> {
  let stage: SystemReviewLimitFailure["stage"] = "baseline";
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
    stage = "delivery_refs";
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
    stage = "ancestry";
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
    stage = "merge_tree";
    const merged = await git.mergeTree(
      repository,
      candidate.previous_sha,
      base,
    );
    if (merged.conflicts.length) return null;
    stage = "delivery_tree";
    const tree = await git.treeOfCommit(repository, candidate.delivery_sha);
    if (tree !== merged.tree) return null;
    stage = "changed_paths";
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
    stage = "baseline_recheck";
    if ((await git.readRef(repository, baseline)) !== base) return null;
    return {
      candidate,
      base_sha: base,
      merged_tree: merged.tree,
      delivery_tree: tree,
      changed_paths: paths,
    };
  } catch (error) {
    // Missing objects, unsupported Git, unreadable paths and uncertain results never grant a round.
    return systemReviewLimitFailure(error, stage);
  }
}
