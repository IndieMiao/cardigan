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
import type { CentralProject, CentralRepositoryService } from "./central.js";
import { reviewEquivalence } from "./review-equivalence.js";
import { collectRoleRuleInventory } from "./role-rule-inventory.js";

/** prepareDelivery supplies the Assignment from its database snapshot, not tool parameters. */
export class GitDeliveryVerifier implements DeliveryVerifier {
  constructor(
    private readonly central: CentralRepositoryService,
    private readonly project: CentralProject,
  ) {}
  /** Fetch exactly the recorded Assignment branch, with the same transport as delivery. */
  async head(a: Assignment): Promise<string> {
    if (
      !parseId("assignment", a.id).ok ||
      a.status !== "active" ||
      a.machine_id !== "local" ||
      a.scope !== "work_item" ||
      !a.branch ||
      !a.worktree_path ||
      !isAbsolute(a.worktree_path)
    )
      throw new Error("Invalid precheck Assignment");
    const repository = await this.central.ensureCentral(this.project);
    const source = await this.central.agentSource(this.project);
    const incoming = `refs/cardigan/incoming/${a.id}`;
    await this.central.git.readRef(repository, `refs/heads/${a.branch}`);
    await this.central.git.fetchRefs(
      repository,
      source.path,
      [`+refs/heads/${a.branch}:${incoming}`],
      source.uploadPack,
    );
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
      a.machine_id !== "local" ||
      a.scope !== "work_item" ||
      !a.branch ||
      !a.worktree_path ||
      !isAbsolute(a.worktree_path)
    )
      return validationFailed(
        "Git delivery requires a local writing Assignment with a recorded branch and worktree",
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
      const incoming = `refs/cardigan/incoming/${a.id}`,
        source = await this.central.agentSource(this.project);
      // Validate the full ref before building the refspec; never trust a submitted branch.
      await git.readRef(repository, `refs/heads/${a.branch}`);
      await git.fetchRefs(
        repository,
        source.path,
        [`+refs/heads/${a.branch}:${incoming}`],
        source.uploadPack,
      );
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
        a.base_sha ??
        (await git.readRef(
          repository,
          `refs/heads/${this.project.base_branch}`,
        ));
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
      const baseline = await git.readRef(
        repository,
        `refs/heads/${this.project.base_branch}`,
      );
      // Main changes already included in the branch are not this author's risk.
      // Keep the original Assignment baseline in commit/role evidence for audit.
      const ownInventory =
        baseline &&
        baseline !== base_sha &&
        (await git.isAncestor(repository, baseline, sha))
          ? await collectRoleRuleInventory(git, repository, baseline, sha)
          : undefined;
      const ownPaths: DeliveryEvidence | undefined = ownInventory
        ? {
            kind: "diff",
            details: {
              own_path_inventory: {
                version: 1,
                sha,
                tree_sha,
                base_sha: baseline ?? base_sha,
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
