import { invalidTestReviewPasses } from "./test-review.js";
import { isReviewStale } from "../derived.js";
import type { Decision, Delivery } from "../entities.js";
import { attempt, type CommandState } from "./core.js";
import { riskTagAutoMergeAllowed } from "./delegation.js";
import { latestMergeCheck } from "./merge-check-view.js";
import { mergeContext } from "./merge-context.js";
import { roleRuleMergeReason } from "./role-rule-implementation.js";
import { screenshotCheckBlocker } from "./screenshot-check.js";

const newest = (values: readonly Delivery[]) =>
  [...values].sort(
    (a, b) => Number(b.id.replace(/\D/g, "")) - Number(a.id.replace(/\D/g, "")),
  )[0];

/**
 * §7.4: PM Ops may choose `merge` only when the merge gate passed for the
 * current completion, every non-cancelled verify item passed (required or
 * not) and no must_fix remains open. An empty list means merge is allowed;
 * otherwise PM Ops can only hold, request changes or hand the confirmation
 * to the human.
 */
export function pmMergeBlockers(
  state: CommandState,
  q: Decision,
): readonly string[] {
  if (
    q.trigger !== "merge_confirmation" ||
    !q.card_id ||
    q.kind !== "approve" ||
    !("delivery_id" in q.target)
  )
    return ["不是合并确认"];
  const card_id = q.card_id;
  const context = attempt(() => mergeContext(state, card_id));
  if (!context.ok) return [context.error.message];
  const completion = context.value.target;
  if (completion.id !== q.target.delivery_id)
    return ["合并确认属于旧的完成申请"];
  const blockers: string[] = [];
  if (
    invalidTestReviewPasses(
      state,
      state.deliveries.filter(
        (v) =>
          v.status !== "superseded" &&
          state.work_items.some(
            (w) => w.id === v.work_item_id && w.card_id === q.card_id,
          ),
      ),
    ).length
  )
    blockers.push("增量复核的隔离证据已失效，须完整复核");
  const roleReason = roleRuleMergeReason(state, q);
  if (roleReason) blockers.push(roleReason);
  if (
    context.value.card.risk_tags?.length &&
    !riskTagAutoMergeAllowed(state, q)
  )
    blockers.push("风险标签卡须有必需且有效的独立复核通过，否则须交人确认");
  const screenshot = screenshotCheckBlocker(state, context.value.card);
  if (screenshot) blockers.push(screenshot);
  const check = latestMergeCheck(state.events, card_id, completion.id);
  if (check?.status !== "passed")
    blockers.push(
      check
        ? `合并闸门检查未通过（当前 ${check.status}）`
        : "合并闸门检查尚无结果（未开启闸门的项目须交人确认）",
    );
  const items = state.work_items.filter(
    (w) => w.card_id === card_id && w.status !== "cancelled",
  );
  // Every live verifier counts, required or not: `required` is editable by
  // PM Ops on added items, so it cannot waive verification here. Waiving one
  // is the human's call (escalate).
  for (const w of items.filter((w) => w.kind === "verify"))
    if (w.status !== "passed") blockers.push(`验证项 ${w.id} 未通过`);
  const current = items
    .map((w) =>
      newest(
        state.deliveries.filter(
          (v) =>
            v.work_item_id === w.id &&
            v.kind !== "card_completion" &&
            v.status !== "superseded",
        ),
      ),
    )
    .filter((v): v is Delivery => !!v);
  for (const w of items.filter((w) => w.kind === "produce" && w.required))
    if (
      !current.some((v) => v.work_item_id === w.id && v.status === "accepted")
    )
      blockers.push(`产出项 ${w.id} 的最新交付未通过验收`);
  for (const v of [...current, completion]) {
    for (const id of v.requested_verifiers)
      if (
        items.some((w) => w.id === id) &&
        !state.reviews.some(
          (r) =>
            r.work_item_id === id &&
            r.verdict === "pass" &&
            !isReviewStale(r, v),
        )
      )
        blockers.push(`验证项 ${id} 未通过当前交付审核`);
    const latest = latestReviews(state, v);
    for (const r of latest.values())
      if (r.issues.some((i) => i.must_fix && !i.pre_existing))
        blockers.push(`审核 ${r.id} 有未处理的 must_fix`);
  }
  return [...new Set(blockers)];
}

/** Same current-review selection as PM delegation; superseded verdicts do not count. */
export function latestReviews(state: CommandState, v: Delivery) {
  const latest = new Map<string, (typeof state.reviews)[number]>();
  for (const r of state.reviews)
    if (!isReviewStale(r, v)) {
      const seen = latest.get(r.work_item_id);
      if (!seen || Number(r.id.slice(2)) > Number(seen.id.slice(2)))
        latest.set(r.work_item_id, r);
    }
  return latest;
}
