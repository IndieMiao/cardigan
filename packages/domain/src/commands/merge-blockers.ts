import { autoRiskPaths } from "../auto-risk.js";
import { unmetCardDependencies } from "../card-dependencies.js";
import { isReviewStale } from "../derived.js";
import type { Decision, Delivery } from "../entities.js";
import { autoMergeOn } from "../preferences.js";
import { attempt, type CommandState } from "./core.js";
import { riskTagAutoMergeAllowed } from "./delegation.js";
import { latestMergeCheck } from "./merge-check-view.js";
import { mergeContext } from "./merge-context.js";
import { effectivePreMergeChecks } from "./pre-merge-check-view.js";
import {
  screenshotCheckBlocker,
  screenshotCheckEnforced,
} from "./screenshot-check.js";
import { systemMergeEnabled } from "./system-merge-policy.js";
import { invalidTestReviewPasses } from "./test-review.js";

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
  const missing = unmetCardDependencies(state, context.value.card);
  if (missing.length)
    blockers.push(`前置卡尚未正常完成：${missing.join("、")}`);
  if (context.value.card.hold) blockers.push("卡片已暂停，请先解除暂停");
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
  if (!riskTagAutoMergeAllowed(state, q))
    blockers.push("高危交付须有当前有效的必需独立复核");
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

/** A3: the system must also consume the human's current pre-merge checklist. */
export function systemMergeBlockers(
  state: CommandState,
  q: Decision,
): readonly string[] {
  const lite = autoMergeOn(
    state.project_preferences?.find((p) => p.id === state.project_id),
  );
  const blockers = pmMergeBlockers(
    lite
      ? {
          ...state,
          work_items: state.work_items.filter(
            (w) => w.kind !== "verify" || w.required,
          ),
        }
      : state,
    q,
  );
  const card = state.cards.find((c) => c.id === q.card_id);
  if (!card || !systemMergeEnabled(state, card)) return blockers;
  if (
    autoMergeOn(
      state.project_preferences?.find((p) => p.id === state.project_id),
    )
  ) {
    const products = state.work_items.filter(
      (w) =>
        w.card_id === card.id &&
        w.kind === "produce" &&
        w.status !== "cancelled",
    );
    if (
      products.some((w) => {
        const latest = newest(
          state.deliveries.filter(
            (v) =>
              v.work_item_id === w.id &&
              v.kind !== "card_completion" &&
              v.status !== "superseded",
          ),
        );
        return !latest || autoRiskPaths(latest) === undefined;
      })
    )
      return [...blockers, "缺少完整的当前交付文件差异证据"];
  }
  const checks = effectivePreMergeChecks(
    card,
    state.work_items,
    state.deliveries,
    screenshotCheckEnforced(state),
  );
  return [
    ...new Set([
      ...blockers,
      ...checks
        .filter((c) => c.status !== "passed")
        .map(
          (c) =>
            `${c.label}：${c.status === "failed" ? "未通过" : "待核"}${c.stale ? "（当前交付需重新核对）" : ""}`,
        ),
    ]),
  ];
}
