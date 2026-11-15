import type {
  AssignmentId,
  DeliveryId,
  ProjectId,
  ReviewId,
  WorkItemId,
} from "./ids.js";

/** Host-built data. No tool accepts any of these fields from an Agent. */
export interface TestReviewCandidate {
  readonly project_id: ProjectId;
  readonly work_item_id: WorkItemId;
  readonly verifier_id: WorkItemId;
  readonly assignment_id: AssignmentId;
  readonly previous_delivery_id: DeliveryId;
  readonly previous_review_id: ReviewId;
  readonly context: string;
  readonly old_sha: string;
  readonly old_tree: string;
  readonly new_sha: string;
  readonly base_branch: string;
}

export interface TestReviewProof extends TestReviewCandidate {
  readonly new_tree: string;
  readonly baseline_sha: string;
  readonly baseline_tree: string;
  readonly files: readonly string[];
  readonly ranges: readonly {
    readonly base: string;
    readonly head: string;
    readonly files: readonly string[];
  }[];
  readonly baseline_merges: readonly {
    readonly commit: string;
    readonly first_parent: string;
    readonly baseline_parent: string;
    readonly tree: string;
  }[];
  readonly policy_boundary_generation: string;
  readonly policy_digest: string;
  readonly policy_version: string;
  readonly source_version: string;
  readonly input_digest: string;
  readonly isolation_generation: string;
  /** A restarted authority cannot revive a persisted lease. */
  readonly authority: string;
}

export interface TestReviewBinding extends TestReviewProof {
  readonly delivery_id: DeliveryId;
}

/**
 * Trusted host adapter, absent by default. `isCurrent` must fail closed and
 * recheck policy, identity/write protection and the enforced input boundary.
 * The live center baseline must equal proof.baseline_sha; preparation must
 * prove it is an ancestor of new_sha, so new_tree is the publication tree.
 * A source must revoke its generation BEFORE changing any of those facts.
 * This synchronous guard is called inside each consuming state transaction;
 * expensive Git/collection work belongs in prepare, outside the transaction.
 */
export interface TestReviewTrust {
  prepare(candidate: TestReviewCandidate): Promise<TestReviewProof | undefined>;
  isCurrent(proof: TestReviewProof): boolean;
}
