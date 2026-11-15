import { isAbsolute } from "node:path";
import {
  type Assignment,
  type DeliveryEvidence,
  type DeliverySubject,
  type DeliveryVerifier,
  parseId,
  type Result,
  validationFailed,
} from "@cardigan/domain";
import type { CentralProject, CentralRepositoryService } from "./central.js";
import { collectRoleRuleInventory } from "./role-rule-inventory.js";

/** prepareDelivery supplies the Assignment from its database snapshot, not tool parameters. */
export class GitDeliveryVerifier implements DeliveryVerifier {
  constructor(
    private readonly central: CentralRepositoryService,
    private readonly project: CentralProject,
  ) {}
  async verify(
    subject: DeliverySubject,
    assignment: Assignment,
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
      return {
        ok: true,
        value: [
          {
            kind: "diff",
            details: {
              role_rule_inventory: JSON.parse(JSON.stringify(inventory)),
            },
          },
          {
            kind: "commit",
            details: {
              sha,
              tree_sha,
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
