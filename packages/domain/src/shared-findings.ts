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

const sourceId = (r: Review["id"], index: number) => `${r}:${index + 1}`;

/** Project from the current lane bindings, including reviews submitted before a peer was added. */
export function sharedMustFixes(
  reviews: readonly Review[],
  deliveries: readonly Delivery[],
  items: readonly WorkItem[],
) {
  const scopes = new Map(
    deliveries.map((d) => [
      d.id,
      { sha: d.subject.value, lanes: sharedReviewers(d, items) },
    ]),
  );
  const seen = new Set<string>();
  return reviews
    .filter((r) => {
      const scope = scopes.get(r.delivery_id);
      return (
        !r.withdrawn &&
        scope?.sha === r.target_sha &&
        scope.lanes.includes(r.work_item_id)
      );
    })
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
    .flatMap((r) =>
      r.issues.flatMap((issue, index) => {
        if (!issue.must_fix || issue.pre_existing) return [];
        const finding_id = issue.finding_id ?? sourceId(r.id, index);
        if (seen.has(finding_id)) return [];
        seen.add(finding_id);
        return [
          {
            ...issue,
            finding_id,
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
      i.finding_id ?? ids.get(key(i)) ?? sourceId(reviewId, index);
    ids.set(key(i), finding_id);
    return { ...i, finding_id };
  });
}
