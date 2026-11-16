import type {
  Card,
  Delivery,
  PreMergeCheck,
  PreMergeCheckedVersion,
  WorkItem,
} from "../entities.js";
import { SCREENSHOT_CHECK_LABEL } from "./screenshot-check.js";

export const INDEPENDENT_REVIEW_CHECK_LABEL = "独立复核";

const numericId = (id: string): number => Number(/(\d+)$/u.exec(id)?.[1] ?? 0);

/**
 * The version a pre-merge conclusion applies to: each producing work item's
 * newest non-superseded delivery (the same candidates the merge will take).
 */
export function currentPreMergeVersions(
  card: Pick<Card, "id">,
  workItems: readonly WorkItem[],
  deliveries: readonly Delivery[],
): readonly PreMergeCheckedVersion[] {
  return workItems
    .filter((w) => w.card_id === card.id && w.kind === "produce")
    .sort((a, b) => numericId(a.id) - numericId(b.id))
    .flatMap((w) => {
      const latest = deliveries
        .filter(
          (d) =>
            d.work_item_id === w.id &&
            d.kind !== "card_completion" &&
            d.status !== "superseded",
        )
        .sort((a, b) => numericId(b.id) - numericId(a.id))[0];
      return latest
        ? [
            {
              work_item_id: w.id,
              delivery_id: latest.id,
              subject: latest.subject.value,
            },
          ]
        : [];
    });
}
/**
 * Labels whose conclusions come only from Review projections: they bind to the
 * delivery ID (like isReviewStale) and do not use an ordinary-check slot. The
 * screenshot check joins them only while the reviewer-browser switch is on.
 */
export const reservedPreMergeCheckLabels = (
  screenshotEnforced: boolean,
): readonly string[] =>
  screenshotEnforced
    ? [INDEPENDENT_REVIEW_CHECK_LABEL, SCREENSHOT_CHECK_LABEL]
    : [INDEPENDENT_REVIEW_CHECK_LABEL];
export const samePreMergeCheckVersions = (
  a: readonly PreMergeCheckedVersion[] | undefined,
  b: readonly PreMergeCheckedVersion[],
  label?: string,
  screenshotEnforced = false,
) =>
  a !== undefined &&
  a.length === b.length &&
  a.every(
    (v, i) =>
      v.work_item_id === b[i]?.work_item_id &&
      v.subject === b[i]?.subject &&
      (label === undefined ||
        !reservedPreMergeCheckLabels(screenshotEnforced).includes(label) ||
        v.delivery_id === b[i]?.delivery_id),
  );

export interface EffectivePreMergeCheck extends PreMergeCheck {
  /** A passed/failed conclusion reached on an older version; reads as pending. */
  readonly stale: boolean;
}
/**
 * C-160: a passed/failed conclusion only holds for the version it was reached
 * on. Independent reviews also bind to the delivery ID, like isReviewStale;
 * reuse explicitly rebinds the projection while preserving its source Review.
 */
export function effectivePreMergeChecks(
  card: Pick<Card, "id" | "pre_merge_checks">,
  workItems: readonly WorkItem[],
  deliveries: readonly Delivery[],
  /** Q-336 (a): pass `screenshotCheckEnforced(state)` from the caller. */
  screenshotEnforced = false,
): readonly EffectivePreMergeCheck[] {
  const current = currentPreMergeVersions(card, workItems, deliveries);
  return (card.pre_merge_checks ?? []).map((c) =>
    c.status !== "pending" &&
    !samePreMergeCheckVersions(
      c.checked_versions,
      current,
      c.label,
      screenshotEnforced,
    )
      ? { ...c, status: "pending", stale: true }
      : { ...c, stale: false },
  );
}
/** The checks still standing between the human and a clean merge. */
export function openPreMergeChecks(
  card: Pick<Card, "id" | "pre_merge_checks">,
  workItems: readonly WorkItem[],
  deliveries: readonly Delivery[],
  screenshotEnforced = false,
): readonly EffectivePreMergeCheck[] {
  return effectivePreMergeChecks(
    card,
    workItems,
    deliveries,
    screenshotEnforced,
  ).filter((c) => c.status !== "passed");
}
