import type { Delivery, Review, ReviewIssue, WorkItem } from "./entities.js";

/** Only the two product review lanes share a checklist, never PM acceptance. */
export function sharedReviewers(target: Delivery, items: readonly WorkItem[]) {
  const lanes = items.filter(
    (w) =>
      w.kind === "verify" &&
      w.target_work_item_id === target.work_item_id &&
      target.requested_verifiers.includes(w.id) &&
      ["reviewer", "independent_reviewer"].includes(w.role_id),
  );
  return target.kind !== "card_completion" &&
    new Set(lanes.map((w) => w.role_id)).size === 2
    ? lanes.map((w) => w.id)
    : [];
}

/** IDs are minted by submitReview. The review snapshots remain independently auditable. */
export function sharedMustFixes(reviews: readonly Review[]) {
  const seen = new Set<string>();
  return reviews.flatMap((r) =>
    r.withdrawn
      ? []
      : r.issues.flatMap((issue) => {
          if (!issue.finding_id || seen.has(issue.finding_id)) return [];
          seen.add(issue.finding_id);
          return [
            {
              ...issue,
              finding_id: issue.finding_id,
              delivery_id: r.delivery_id,
              target_sha: r.target_sha,
            },
          ];
        }),
  );
}

/** Identical parallel writes use the same ID; differently worded findings need an explicit reference. */
export function bindSharedFindings(
  issues: readonly ReviewIssue[],
  reviewId: Review["id"],
  existing: readonly ReviewIssue[],
) {
  const key = (i: ReviewIssue) =>
    JSON.stringify([
      i.description.trim(),
      i.severity,
      i.impact,
      i.proof?.trim() ?? "",
    ]);
  const ids = new Map(existing.map((i) => [key(i), i.finding_id]));
  return issues.map((i, index) => {
    if (!i.must_fix || i.pre_existing) return i;
    const finding_id =
      i.finding_id ?? ids.get(key(i)) ?? `${reviewId}:${index + 1}`;
    ids.set(key(i), finding_id);
    return { ...i, finding_id };
  });
}
