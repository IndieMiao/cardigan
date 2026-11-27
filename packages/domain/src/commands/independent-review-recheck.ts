import type { Card, Delivery, WorkItem } from "../entities.js";
import {
  effectivePreMergeChecks,
  INDEPENDENT_REVIEW_CHECK_LABEL,
} from "./pre-merge-check-view.js";

export interface IndependentReviewRecheck {
  /** The passed independent review item the gate no longer accepts. */
  readonly item: WorkItem;
  /** Its target producer, still accepted. */
  readonly producer: WorkItem;
  /** The producer's current accepted delivery, to be reviewed again. */
  readonly target: Delivery;
}

/**
 * C-805: the merge gate and the completion binding share one definition. The
 * gate reads the independent review check as pending (stale or reset) while
 * the review item itself still counts as passed for its current target. Each
 * such item must review its target again; until then no completion may stand.
 */
export function independentReviewRechecks(
  state: {
    readonly work_items: readonly WorkItem[];
    readonly deliveries: readonly Delivery[];
  },
  card: Pick<Card, "id" | "pre_merge_checks">,
  screenshotEnforced: boolean,
): readonly IndependentReviewRecheck[] {
  const check = effectivePreMergeChecks(
    card,
    state.work_items,
    state.deliveries,
    screenshotEnforced,
  ).find((c) => c.label === INDEPENDENT_REVIEW_CHECK_LABEL);
  if (check?.status !== "pending") return [];
  return state.work_items.flatMap((item) => {
    if (
      item.card_id !== card.id ||
      item.kind !== "verify" ||
      item.role_id !== "independent_reviewer" ||
      item.status !== "passed" ||
      item.replaced_by_work_item_id ||
      !item.target_work_item_id
    )
      return [];
    const producer = state.work_items.find(
      (w) => w.id === item.target_work_item_id,
    );
    if (
      producer?.kind !== "produce" ||
      producer.card_id !== card.id ||
      producer.status !== "accepted"
    )
      return [];
    const target = state.deliveries
      .filter(
        (v) =>
          v.work_item_id === producer.id &&
          v.kind !== "card_completion" &&
          v.status !== "superseded",
      )
      .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
    return target?.status === "accepted" ? [{ item, producer, target }] : [];
  });
}
