import type { Decision, Delivery, WorkItem } from "../entities.js";
import {
  highRiskCategories,
  validIndependentReviewDelegationMax,
} from "../preferences.js";
import type { CommandDraft } from "./core.js";
import { currentReviewTarget } from "./review-round.js";

export const INDEPENDENT_REVIEW_LIMIT_HUMAN_REASON =
  "独立复核审核轮数已用完，必须由人确认后续处理";

export function independentReviewLimitItem(
  d: CommandDraft,
  q: Pick<Decision, "trigger"> &
    Partial<Pick<Decision, "affected_work_items" | "review_limit_group">>,
) {
  const ids = q.affected_work_items;
  return q.trigger === "review_limit" &&
    (q.review_limit_group || ids?.length === 1)
    ? d
        .list("work_items")
        .find(
          (w) =>
            ids?.includes(w.id) &&
            w.kind === "verify" &&
            w.role_id === "independent_reviewer",
        )
    : undefined;
}

/** Persisted resolutions survive preference changes, session replacement and restart. */
export function independentReviewDelegatedRaises(
  d: CommandDraft,
  item: WorkItem,
) {
  return d
    .list("decisions")
    .filter(
      (q) =>
        q.trigger === "review_limit" &&
        q.affected_work_items.includes(item.id) &&
        q.resolution?.via === "delegated" &&
        q.resolution.option === "raise_limit",
    );
}

/** Re-evaluated against the command's transaction snapshot, never caller evidence. */
export function independentReviewLimitDelegationAllowed(
  d: CommandDraft,
  item: WorkItem,
): boolean {
  const preferences = d
    .list("project_preferences")
    .find((p) => p.id === d.state.project_id);
  const max = preferences?.independent_review_limit_delegation_max;
  if (
    item.kind !== "verify" ||
    item.role_id !== "independent_reviewer" ||
    item.replaced_by_work_item_id ||
    preferences?.independent_review_limit_delegation !== true ||
    !validIndependentReviewDelegationMax(max)
  )
    return false;
  // The caller has authorized the operation; eligibility reads must not
  // re-interpret a control-plane handoff as access by its triggering author.
  const card = d.get("cards", item.card_id);
  if (card.sensitive || ["done", "cancelled"].includes(card.status))
    return false;
  const source =
    card.source.kind === "decision" ? card.source.decision_id : undefined;
  if (
    d
      .list("decisions")
      .some(
        (q) =>
          q.status !== "withdrawn" &&
          (q.id === source ||
            q.card_id === card.id ||
            q.affected_cards.includes(card.id)) &&
          (q.category === "scope_change" ||
            (!!q.category && highRiskCategories.includes(q.category))),
      )
  )
    return false;
  const raises = independentReviewDelegatedRaises(d, item);
  if (raises.length >= max) return false;
  const target = currentReviewTarget(d, item);
  const prior = d
    .list("reviews")
    .filter((r) => r.work_item_id === item.id)
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
  if (
    !target ||
    !prior ||
    (target.id === prior.delivery_id &&
      target.subject.value === prior.target_sha)
  )
    return false;
  // One new version cannot consume the standing authorization twice, even if
  // another request is created before the resumed reviewer has submitted.
  return !raises.some((q) => {
    const used = q.resolution?.review_limit_target;
    return (
      !used ||
      (used.delivery_id === target.id &&
        used.subject.value === target.subject.value)
    );
  });
}

export function independentReviewLimitTarget(target: Delivery) {
  return { delivery_id: target.id, subject: target.subject };
}
