import { isAbsolute } from "node:path";
import {
  type Assignment,
  CheckHeadFailure,
  type CheckHeadFailureReason,
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
import { RepositoryLockTimeoutError } from "./lock.js";
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
/** Label a failed precheck HEAD stage; lock timeouts stay retryable as-is. */
async function stage<T>(
  reason: CheckHeadFailureReason | ((error: unknown) => CheckHeadFailureReason),
  operation: () => Promise<T> | T,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof RepositoryLockTimeoutError ||
      error instanceof CheckHeadFailure
    )
      throw error;
    throw new CheckHeadFailure(
      typeof reason === "function" ? reason(error) : reason,
      { cause: error },
    );
  }
}
type StageLabel = typeof stage;
/** Verification keeps the Git error text in its own rejection message. */
const unlabelled: StageLabel = (_reason, operation) =>
  Promise.resolve().then(operation);
/** Git reports a branch absent on the worker as a missing remote ref. */
const fetchFailure = (error: unknown): CheckHeadFailureReason => {
  const text = [
    error instanceof Error ? error.message : "",
    (error as { stderr?: unknown } | undefined)?.stderr,
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  return /couldn't find remote ref/iu.test(text)
    ? "branch_missing"
    : "fetch_failed";
};

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
    /**
     * C-847: wall time of each verification stage, reported once when the
     * reads finish (successfully or not). Stage names only, never payloads.
     */
    private readonly onSteps?: (
      steps: Readonly<Record<string, number>>,
    ) => void,
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
  /**
   * Fetch exactly the recorded Assignment branch into a private stage; no ref
   * is written. `label` names the failed stage for a precheck HEAD.
   */
  private async fetchTip(
    a: Assignment & { branch: string },
    repository: string,
    label: StageLabel = unlabelled,
  ) {
    const source = await label("environment_unavailable", () =>
      this.central.agentSource(this.project, a.machine_id),
    );
    // Validate the full ref before building the refspec; never trust a submitted branch.
    await label("ownership_mismatch", () =>
      this.central.git.readRef(repository, `refs/heads/${a.branch}`),
    );
    const head = await label(fetchFailure, () =>
      this.central.git.fetchBranchTip(
        repository,
        source.address,
        a.branch,
        source.uploadPack,
      ),
    );
    await label("environment_unavailable", () => this.central.validateSource());
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
    label: StageLabel = unlabelled,
  ) {
    await label("environment_unavailable", () => this.central.validateSource());
    const git = this.central.git,
      ref = this.incoming(a);
    await label("repository_failed", async () => {
      const current = await git.readRef(repository, ref);
      if (
        current !== head &&
        !(current && (await git.isAncestor(repository, head, current)))
      )
        await git.compareAndSwapRef(repository, ref, head, current ?? null);
    });
  }
  /**
   * Fetch exactly the recorded Assignment branch, with the same transport as
   * delivery. Failures are {@link CheckHeadFailure}s naming the failed stage.
   */
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
      throw new CheckHeadFailure("ownership_mismatch");
    const repository = await stage("repository_failed", () =>
      this.central.ensureCentral(this.project),
    );
    const head = await this.fetchTip(
      { ...a, branch: a.branch },
      repository,
      stage,
    );
    return {
      publish: async () => {
        await this.publishIncoming(repository, a, head, stage);
        await stage("repository_failed", () =>
          this.central.createRef(
            repository,
            `refs/cardigan/prechecks/${a.id}/${head}`,
            head,
          ),
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
    const steps: Record<string, number> = {};
    const step = async <T>(name: string, run: () => Promise<T>) => {
      const started = performance.now();
      try {
        return await run();
      } finally {
        steps[name] = Math.round(
          (steps[name] ?? 0) + performance.now() - started,
        );
      }
    };
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
      const repository = await step("ensure_central", () =>
        this.central.ensureCentral(this.project),
      );
      if (
        sha.length !==
        ((await step("commit_checks", () => git.objectFormat(repository))) ===
        "sha1"
          ? 40
          : 64)
      )
        return rejected(
          validationFailed(
            "Delivery SHA length does not match the repository object format",
          ),
        );
      const branch = a.branch;
      const head = await step("fetch_tip", () =>
        this.fetchTip({ ...a, branch }, repository),
      );
      staged = { repository, head };
      if (
        (await step("commit_checks", () => git.objectType(repository, sha))) !==
        "commit"
      )
        return rejected(
          validationFailed(
            "Delivery SHA is not a commit (missing, tree, blob or tag)",
          ),
        );
      if (
        !(await step("commit_checks", () =>
          git.isAncestor(repository, sha, head),
        ))
      )
        return rejected(
          validationFailed(
            "Delivery SHA is not on the recorded Assignment branch",
          ),
        );
      const baseline = await step("commit_checks", () =>
        git.readRef(repository, this.baselineRef),
      );
      const base_sha = a.base_sha ?? baseline;
      if (!base_sha)
        return rejected(validationFailed("Delivery base SHA is unavailable"));
      const inventory = await step("role_inventory", () =>
        collectRoleRuleInventory(git, repository, base_sha, sha),
      );
      const commits_ahead = await step("commit_count", () =>
        git.countCommits(repository, base_sha, sha),
      );
      const tree_sha = inventory.tree_sha;
      // Card-baseline changes already merged into the branch are not this
      // author's risk. Start from the newest baseline commit the branch
      // contains: the tip itself, or the unique merge base when the baseline
      // has moved on since the author last merged it. Keep the original
      // Assignment baseline in commit/role evidence for audit.
      const ownBase = baseline
        ? await step("own_inventory", () =>
            ownChangesBase(git, repository, baseline, sha),
          )
        : undefined;
      // A start older than the Assignment baseline only widens the inventory,
      // which stays the conservative side.
      const ownInventory =
        ownBase && ownBase !== base_sha
          ? await step("own_inventory", () =>
              collectRoleRuleInventory(git, repository, ownBase, sha),
            )
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
          ? await step("review_equivalence", () =>
              reviewEquivalence(git, repository, baseline, previous, sha),
            )
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
    } finally {
      try {
        this.onSteps?.(steps);
      } catch {
        // A failing log never changes the answer.
      }
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
