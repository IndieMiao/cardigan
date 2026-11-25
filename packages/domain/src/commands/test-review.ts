import type { Delivery, Review, WorkItem } from "../entities.js";
import type { TestReviewBinding, TestReviewCandidate } from "../test-review.js";
import { CommandDraft, type CommandState } from "./core.js";
import { employeeConflicts } from "./employee-assignment.js";
import { deliveryTree, reviewReuseContext } from "./review-context.js";

const latest = (a: Review, b: Review) =>
  Number(b.id.slice(2)) - Number(a.id.slice(2));

/** This proof covers one delivery tree, not a combination of independent products. */
function singleProduct(d: CommandDraft, item: WorkItem, product: string) {
  return !d
    .list("work_items")
    .some(
      (w) =>
        w.card_id === item.card_id &&
        w.kind === "produce" &&
        w.status !== "cancelled" &&
        w.id !== product,
    );
}

function basis(d: CommandDraft, previous: Delivery, item: WorkItem) {
  if (
    item.kind !== "verify" ||
    item.role_id !== "independent_reviewer" ||
    item.status === "cancelled" ||
    item.replaced_by_work_item_id ||
    previous.kind === "card_completion" ||
    !previous.requested_verifiers.includes(item.id) ||
    item.target_work_item_id !== previous.work_item_id ||
    !deliveryTree(previous) ||
    !singleProduct(d, item, previous.work_item_id)
  )
    return;
  const owner = d.list("assignments").find((a) => a.id === item.assignment_id);
  const relevant = d
    .list("work_items")
    .filter(
      (w) =>
        w.card_id === item.card_id &&
        (w.kind === "verify" || w.id === previous.work_item_id),
    );
  const identities = d
    .list("assignments")
    .filter(
      (a) =>
        a.scope === "work_item" &&
        relevant.some((w) => w.id === a.work_item_id),
    );
  if (
    !owner?.employee_id ||
    owner.status !== "active" ||
    relevant.some(
      (w) =>
        !identities.some(
          (a) => a.scope === "work_item" && a.work_item_id === w.id,
        ),
    ) ||
    identities.some(
      (a) =>
        !a.employee_id ||
        !d.state.employees?.some((e) => e.id === a.employee_id),
    ) ||
    employeeConflicts(d, item, owner.employee_id)
  )
    return;
  const reviews = d.list("reviews");
  // A failed/withdrawn/conditional attempt on the current version burns the
  // one incremental opportunity. Re-delivery cannot hide another verifier's fix.
  const review = reviews
    .filter((r) => r.work_item_id === item.id)
    .sort(latest)[0];
  if (
    !review ||
    review.delivery_id !== previous.id ||
    review.target_sha !== previous.subject.value ||
    review.verdict !== "pass" ||
    review.withdrawn ||
    review.recheck_required ||
    review.reuse_invalidated_at ||
    !review.reuse_basis
  )
    return;
  for (const w of relevant.filter((w) => w.kind === "verify")) {
    const last = reviews.filter((r) => r.work_item_id === w.id).sort(latest)[0];
    if (
      last?.issues.some((i) => i.must_fix) ||
      last?.recheck_required ||
      last?.withdrawn
    )
      return;
  }
  if (review.test_review) {
    try {
      if (d.state.test_review_trust?.isCurrent(review.test_review) !== true)
        return;
    } catch {
      return;
    }
  }
  const context = reviewReuseContext(d, previous, item, owner.id);
  if (
    !context ||
    context !== review.reuse_basis.context ||
    owner.id !== review.reuse_basis.assignment_id
  )
    return;
  return { review, context, owner };
}

export function testReviewCandidate(
  d: CommandDraft,
  previous: Delivery | undefined,
  item: WorkItem,
  newSha: string,
): TestReviewCandidate | undefined {
  if (
    !previous ||
    previous.status === "superseded" ||
    previous.status === "rejected" ||
    previous.subject.kind !== "git_head" ||
    previous.subject.value === newSha
  )
    return;
  const b = basis(d, previous, item);
  const card = d.card(item.card_id);
  if (!b || !card.base_branch) return;
  return {
    project_id: d.state.project_id,
    work_item_id: previous.work_item_id,
    verifier_id: item.id,
    assignment_id: b.owner.id,
    previous_delivery_id: previous.id,
    previous_review_id: b.review.id,
    context: b.context,
    old_sha: previous.subject.value,
    old_tree: deliveryTree(previous) as string,
    new_sha: newSha,
    base_branch: card.base_branch,
  };
}

/** Shared by quota admission, Run start, prompts and submit_review. */
export function incrementalTestReview(
  d: CommandDraft,
  item: WorkItem,
  target: Delivery | undefined,
): TestReviewBinding | undefined {
  const proof = target?.test_review;
  if (
    !target ||
    !proof ||
    target.kind === "card_completion" ||
    target.status !== "submitted" ||
    proof.delivery_id !== target.id ||
    proof.project_id !== d.state.project_id ||
    proof.verifier_id !== item.id ||
    proof.work_item_id !== target.work_item_id ||
    target.supersedes !== proof.previous_delivery_id ||
    proof.new_sha !== target.subject.value ||
    proof.new_tree !== deliveryTree(target) ||
    !proof.files.length ||
    !proof.ranges.length ||
    d
      .list("reviews")
      .some((r) => r.work_item_id === item.id && r.delivery_id === target.id)
  )
    return;
  const previous = d
    .list("deliveries")
    .find((v) => v.id === proof.previous_delivery_id);
  if (
    !previous ||
    previous.work_item_id !== target.work_item_id ||
    previous.subject.value !== proof.old_sha ||
    deliveryTree(previous) !== proof.old_tree
  )
    return;
  const b = basis(d, previous, item);
  if (
    !b ||
    b.review.id !== proof.previous_review_id ||
    b.context !== proof.context ||
    b.owner.id !== proof.assignment_id
  )
    return;
  try {
    return d.state.test_review_trust?.isCurrent(proof) === true
      ? proof
      : undefined;
  } catch {
    return;
  }
}

/** Fresh host-selected scope for both new sessions and wake prompts. */
export function testReviewForAssignment(
  state: CommandState,
  assignmentId: string,
) {
  const a = state.assignments.find((a) => a.id === assignmentId);
  if (a?.scope !== "work_item") return;
  const item = state.work_items.find((w) => w.id === a.work_item_id);
  if (item?.kind !== "verify") return;
  const d = new CommandDraft(
    state,
    { kind: "system", project_id: state.project_id },
    "queue_run",
  );
  const target = d
    .list("deliveries")
    .find(
      (v) =>
        v.status !== "superseded" && v.requested_verifiers.includes(item.id),
    );
  return incrementalTestReview(d, item, target);
}

/** External facts read in addition to the versioned command state. */
export interface TestReviewProofRead {
  readonly proof: TestReviewBinding;
  readonly current: boolean;
}

export function testReviewProofCurrent(
  trust: CommandState["test_review_trust"],
  proof: TestReviewBinding,
) {
  try {
    return trust?.isCurrent(proof) === true;
  } catch {
    return false;
  }
}

/** An incremental pass cannot authorize completion/publication after source revocation. */
export function testReviewPassValid(
  state: CommandState,
  review: Review,
  proofReads?: TestReviewProofRead[],
): boolean {
  if (!review.test_review) return true;
  const proof = review.test_review;
  const item = state.work_items.find((w) => w.id === review.work_item_id);
  const delivery = state.deliveries.find((v) => v.id === review.delivery_id);
  const prior = state.reviews.find((r) => r.id === proof.previous_review_id);
  if (
    !item ||
    !delivery ||
    !prior ||
    prior.withdrawn ||
    prior.reuse_invalidated_at ||
    prior.verdict !== "pass" ||
    review.withdrawn ||
    review.reuse_invalidated_at
  )
    return false;
  const d = new CommandDraft(
    state,
    { kind: "system", project_id: state.project_id },
    "queue_run",
  );
  if (!singleProduct(d, item, delivery.work_item_id)) return false;
  if (
    reviewReuseContext(d, delivery, item, proof.assignment_id) !== proof.context
  )
    return false;
  const current = testReviewProofCurrent(state.test_review_trust, proof);
  proofReads?.push({ proof, current });
  return current;
}

/** Only the effective latest conclusion for each verifier can block publication. */
export function invalidTestReviewPasses(
  state: CommandState,
  targets: readonly Delivery[],
  proofReads?: TestReviewProofRead[],
): readonly Review[] {
  return targets.flatMap((target) => {
    const latestReviews = new Map<string, Review>();
    // C-670: sort only this target's reviews (a stable sort of the subset
    // keeps the same first match per verifier as sorting every review).
    for (const r of state.reviews
      .filter(
        (r) =>
          r.delivery_id === target.id || target.reused_reviews?.includes(r.id),
      )
      .sort(latest)) {
      if (!latestReviews.has(r.work_item_id))
        latestReviews.set(r.work_item_id, r);
    }
    return [...latestReviews.values()].filter(
      (r) => r.test_review && !testReviewPassValid(state, r, proofReads),
    );
  });
}
