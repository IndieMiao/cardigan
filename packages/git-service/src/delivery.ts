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

/**
 * C-642: a delivery source read in two phases. Everything remote or slow has
 * already happened; `publish` only writes local refs and is the one step a
 * caller runs under the project repository lock. A `value` is already the
 * answer; its optional `record` is a best-effort ref write under the same lock
 * whose failure (including a lock timeout) never changes that answer.
 */
export type StagedDeliverySource<T> =
  | { readonly value: T; readonly record?: () => Promise<void> }
  | { readonly publish: () => Promise<T> };

/** Run both phases without a lock (single-process callers and tests). */
async function settleDeliverySource<T>(
  staged: StagedDeliverySource<T>,
): Promise<T> {
  if (!("value" in staged)) return staged.publish();
  await staged.record?.().catch(() => undefined);
  return staged.value;
}

const failureMessage = (error: unknown) =>
  `Git delivery verification failed: ${error instanceof Error ? error.message : "Git operation failed"}`;

/** prepareDelivery supplies the Assignment from its database snapshot, not tool parameters. */
export class GitDeliveryVerifier implements DeliveryVerifier {
  constructor(
    private readonly central: CentralRepositoryService,
    private readonly project: CentralProject,
  ) {}
  private incoming(a: Assignment) {
    return a.machine_id === "local"
      ? `refs/cardigan/incoming/${a.id}`
      : `refs/cardigan/incoming/${a.machine_id}/${a.id}`;
  }
  /** Fetch exactly the recorded Assignment branch into a private stage; no ref is written. */
  private async stage(a: Assignment & { branch: string }, repository: string) {
    const source = await this.central.agentSource(this.project, a.machine_id);
    // Validate the full ref before building the refspec; never trust a submitted branch.
    await this.central.git.readRef(repository, `refs/heads/${a.branch}`);
    const head = await this.central.git.fetchBranchTip(
      repository,
      source.address,
      a.branch,
      source.uploadPack,
    );
    this.central.validateSource();
    return head;
  }
  /**
   * The fetched tip of this Assignment. Reads overlap outside the lock, so an
   * older tip published late never moves the ref back onto its ancestor.
   */
  private async publishIncoming(
    repository: string,
    a: Assignment,
    head: string,
  ) {
    this.central.validateSource();
    const ref = this.incoming(a),
      current = await this.central.git.readRef(repository, ref);
    if (
      current !== head &&
      !(
        current &&
        (await this.central.git.isAncestor(repository, head, current))
      )
    )
      await this.central.git.compareAndSwapRef(
        repository,
        ref,
        head,
        current ?? null,
      );
  }
  async head(a: Assignment): Promise<string> {
    return settleDeliverySource(await this.prepareHead(a));
  }
  /** Same transport as delivery; the precheck ref is published by the caller. */
  async prepareHead(a: Assignment): Promise<StagedDeliverySource<string>> {
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
    const head = await this.stage({ ...a, branch: a.branch }, repository);
    return {
      publish: async () => {
        await this.publishIncoming(repository, a, head);
        await this.central.createRef(
          repository,
          `refs/cardigan/prechecks/${a.id}/${head}`,
          head,
        );
        return head;
      },
    };
  }
  async verify(
    subject: DeliverySubject,
    assignment: Assignment,
    previous?: Delivery,
  ): Promise<Result<readonly DeliveryEvidence[]>> {
    return settleDeliverySource(
      await this.prepareVerify(subject, assignment, previous),
    );
  }
  /** All Git reads and the remote fetch; `publish` writes the incoming and candidate refs. */
  async prepareVerify(
    subject: DeliverySubject,
    assignment: Assignment,
    previous?: Delivery,
  ): Promise<StagedDeliverySource<Result<readonly DeliveryEvidence[]>>> {
    if (subject.kind !== "git_head") return { value: { ok: true, value: [] } };
    const sha = subject.value,
      a = assignment,
      git = this.central.git;
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha))
      return {
        value: validationFailed(
          "Delivery SHA must be full lowercase hexadecimal",
        ),
      };
    if (
      !parseId("assignment", a.id).ok ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(a.machine_id) ||
      a.scope !== "work_item" ||
      !a.branch ||
      !a.worktree_path ||
      !isAbsolute(a.worktree_path)
    )
      return {
        value: validationFailed(
          "Git delivery requires a writing Assignment with a recorded branch and worktree",
        ),
      };
    let staged: { repository: string; head: string } | undefined;
    // A rejected delivery still records the fetched tip, as before C-642.
    const rejected = (
      failure: Result<readonly DeliveryEvidence[]>,
    ): StagedDeliverySource<Result<readonly DeliveryEvidence[]>> => {
      const fetched = staged;
      return fetched
        ? {
            value: failure,
            record: () =>
              this.publishIncoming(fetched.repository, a, fetched.head),
          }
        : { value: failure };
    };
    try {
      const repository = await this.central.ensureCentral(this.project);
      if (
        sha.length !==
        ((await git.objectFormat(repository)) === "sha1" ? 40 : 64)
      )
        return rejected(
          validationFailed(
            "Delivery SHA length does not match the repository object format",
          ),
        );
      const head = await this.stage({ ...a, branch: a.branch }, repository);
      staged = { repository, head };
      if ((await git.objectType(repository, sha)) !== "commit")
        return rejected(
          validationFailed(
            "Delivery SHA is not a commit (missing, tree, blob or tag)",
          ),
        );
      if (!(await git.isAncestor(repository, sha, head)))
        return rejected(
          validationFailed(
            "Delivery SHA is not on the recorded Assignment branch",
          ),
        );
      const base_sha =
        a.base_sha ??
        (await git.readRef(
          repository,
          `refs/heads/${this.project.base_branch}`,
        ));
      if (!base_sha)
        return rejected(validationFailed("Delivery base SHA is unavailable"));
      const inventory = await collectRoleRuleInventory(
        git,
        repository,
        base_sha,
        sha,
      );
      const commits_ahead = await git.countCommits(repository, base_sha, sha);
      const tree_sha = await git.treeOfCommit(repository, sha);
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
      const evidence: readonly DeliveryEvidence[] = [
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
      ];
      return {
        publish: async () => {
          try {
            await this.publishIncoming(repository, a, head);
            await this.central.createRef(
              repository,
              `refs/cardigan/candidates/${a.id}/${sha}`,
              sha,
            );
            return { ok: true, value: evidence };
          } catch (error) {
            return validationFailed(failureMessage(error));
          }
        },
      };
    } catch (error) {
      return rejected(validationFailed(failureMessage(error)));
    }
  }
}
