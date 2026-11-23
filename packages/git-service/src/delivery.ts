import { isAbsolute } from "node:path";
import {
  type Assignment,
  type Delivery,
  type DeliveryEvidence,
  type DeliverySubject,
  type DeliveryVerifier,
  parseId,
  type Result,
  validationFailed,
} from "@cardigan/domain";
import {
  type CentralProject,
  type CentralRepositoryService,
  validCentralBranch,
} from "./central.js";
import { reviewEquivalence } from "./review-equivalence.js";
import { collectRoleRuleInventory } from "./role-rule-inventory.js";

/** prepareDelivery supplies the Assignment from its database snapshot, not tool parameters. */
export class GitDeliveryVerifier implements DeliveryVerifier {
  /**
   * `baselineBranch` is the card's own baseline (C-589 multi-baseline). The
   * author's own changes are measured against it; the project baseline is
   * used only when the card names none.
   */
  constructor(
    private readonly central: CentralRepositoryService,
    private readonly project: CentralProject,
    private readonly baselineBranch?: string,
  ) {
    if (baselineBranch !== undefined && !validCentralBranch(baselineBranch))
      throw new Error("Invalid card baseline branch name");
  }
  private get baselineRef() {
    return `refs/heads/${this.baselineBranch ?? this.project.base_branch}`;
  }
  private incoming(a: Assignment) {
    return a.machine_id === "local"
      ? `refs/cardigan/incoming/${a.id}`
      : `refs/cardigan/incoming/${a.machine_id}/${a.id}`;
  }
  /** Fetch exactly the recorded Assignment branch, with the same transport as delivery. */
  async head(a: Assignment): Promise<string> {
    if (
      !parseId("assignment", a.id).ok ||
      a.status !== "active" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(a.machine_id) ||
      a.scope !== "work_item" ||
      !a.branch ||
      !a.worktree_path ||
      !isAbsolute(a.worktree_path)
    )
      throw new Error("Invalid precheck Assignment");
    const repository = await this.central.ensureCentral(this.project);
    const source = await this.central.agentSource(this.project, a.machine_id);
    const incoming = this.incoming(a);
    await this.central.git.readRef(repository, `refs/heads/${a.branch}`);
    await this.central.git.fetchRefs(
      repository,
      source.address,
      [`+refs/heads/${a.branch}:${incoming}`],
      source.uploadPack,
    );
    this.central.validateSource();
    const head = await this.central.git.readRef(repository, incoming);
    if (
      !head ||
      (await this.central.git.objectType(repository, head)) !== "commit"
    )
      throw new Error("No branch HEAD");
    await this.central.createRef(
      repository,
      `refs/cardigan/prechecks/${a.id}/${head}`,
      head,
    );
    return head;
  }
  async verify(
    subject: DeliverySubject,
    assignment: Assignment,
    previous?: Delivery,
  ): Promise<Result<readonly DeliveryEvidence[]>> {
    if (subject.kind !== "git_head") return { ok: true, value: [] };
    const sha = subject.value,
      a = assignment,
      git = this.central.git;
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha))
      return validationFailed(
        "Delivery SHA must be full lowercase hexadecimal",
      );
    if (
      !parseId("assignment", a.id).ok ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(a.machine_id) ||
      a.scope !== "work_item" ||
      !a.branch ||
      !a.worktree_path ||
      !isAbsolute(a.worktree_path)
    )
      return validationFailed(
        "Git delivery requires a writing Assignment with a recorded branch and worktree",
      );
    try {
      const repository = await this.central.ensureCentral(this.project);
      if (
        sha.length !==
        ((await git.objectFormat(repository)) === "sha1" ? 40 : 64)
      )
        return validationFailed(
          "Delivery SHA length does not match the repository object format",
        );
      const incoming = this.incoming(a),
        source = await this.central.agentSource(this.project, a.machine_id);
      // Validate the full ref before building the refspec; never trust a submitted branch.
      await git.readRef(repository, `refs/heads/${a.branch}`);
      await git.fetchRefs(
        repository,
        source.address,
        [`+refs/heads/${a.branch}:${incoming}`],
        source.uploadPack,
      );
      this.central.validateSource();
      const head = await git.readRef(repository, incoming);
      if ((await git.objectType(repository, sha)) !== "commit")
        return validationFailed(
          "Delivery SHA is not a commit (missing, tree, blob or tag)",
        );
      if (!head || !(await git.isAncestor(repository, sha, head)))
        return validationFailed(
          "Delivery SHA is not on the recorded Assignment branch",
        );
      const base_sha =
        a.base_sha ?? (await git.readRef(repository, this.baselineRef));
      if (!base_sha)
        return validationFailed("Delivery base SHA is unavailable");
      const inventory = await collectRoleRuleInventory(
        git,
        repository,
        base_sha,
        sha,
      );
      const commits_ahead = await git.countCommits(repository, base_sha, sha);
      const tree_sha = await git.treeOfCommit(repository, sha);
      await this.central.createRef(
        repository,
        `refs/cardigan/candidates/${a.id}/${sha}`,
        sha,
      );
      const baseline = await git.readRef(repository, this.baselineRef);
      // Card-baseline changes already merged into the branch are not this
      // author's risk. Start from the newest baseline commit the branch
      // contains: the tip itself, or the unique merge base when the baseline
      // has moved on since the author last merged it. Keep the original
      // Assignment baseline in commit/role evidence for audit.
      const ownBase = baseline
        ? await ownChangesBase(git, repository, baseline, sha)
        : undefined;
      // A start older than the Assignment baseline only widens the inventory,
      // which stays the conservative side.
      const ownInventory =
        ownBase && ownBase !== base_sha
          ? await collectRoleRuleInventory(git, repository, ownBase, sha)
          : undefined;
      const ownPaths: DeliveryEvidence | undefined =
        ownInventory && ownBase && baseline
          ? {
              kind: "diff",
              details: {
                own_path_inventory: {
                  version: 1,
                  sha,
                  tree_sha,
                  base_sha: ownBase,
                  baseline_sha: baseline,
                  assignment_base_sha: base_sha,
                  complete: ownInventory.complete,
                  paths: ownInventory.changes.map((change) => change.path),
                },
              },
            }
          : undefined;
      const equivalence =
        previous && baseline
          ? await reviewEquivalence(git, repository, baseline, previous, sha)
          : undefined;
      return {
        ok: true,
        value: [
          ...(equivalence ? [equivalence] : []),
          {
            kind: "diff",
            details: {
              role_rule_inventory: JSON.parse(JSON.stringify(inventory)),
            },
          },
          ...(ownPaths ? [ownPaths] : []),
          {
            kind: "commit",
            details: {
              sha,
              tree_sha,
              branch_head_sha: head,
              branch: a.branch,
              base_sha,
              commits_ahead,
            },
          },
        ],
      };
    } catch (error) {
      return validationFailed(
        `Git delivery verification failed: ${error instanceof Error ? error.message : "Git operation failed"}`,
      );
    }
  }
}

/**
 * The newest card-baseline commit contained in the delivery: the baseline tip
 * when the branch already contains it, otherwise the single merge base of the
 * two. Unrelated histories, criss-cross merges (several bases) or a Git
 * adapter without merge-base support yield nothing, so verification falls
 * back to the full Assignment-baseline inventory.
 */
async function ownChangesBase(
  git: CentralRepositoryService["git"],
  repository: string,
  baseline: string,
  sha: string,
): Promise<string | undefined> {
  if (await git.isAncestor(repository, baseline, sha)) return baseline;
  const bases = (await git.mergeBases?.(repository, sha, baseline)) ?? [];
  return bases.length === 1 ? bases[0] : undefined;
}
