import { missingAutoRiskPathEvidence } from "../auto-risk.js";
import { unmetCardDependencies } from "../card-dependencies.js";
import { isReviewStale, reviewPassed, unresolvedMustFix } from "../derived.js";
import type { Decision, Delivery, WorkItem } from "../entities.js";
import { passedCardCheck } from "../merge-batch.js";
import { autoMergeOn } from "../preferences.js";
import { attempt, type CommandState } from "./core.js";
import { mergeRiskBlockers } from "./delegation.js";
import { latestMergeCheck } from "./merge-check-view.js";
import { mergeContext, newestById } from "./merge-context.js";
import { missingMergeCheckReason } from "./merge-failure-view.js";
import {
  type EffectivePreMergeCheck,
  effectivePreMergeChecks,
} from "./pre-merge-check-view.js";
import {
  screenshotCheckBlocker,
  screenshotCheckEnforced,
} from "./screenshot-check.js";
import { systemMergeEnabled } from "./system-merge-policy.js";
import {
  invalidTestReviewPasses,
  type TestReviewProofRead,
} from "./test-review.js";

/**
 * C-631: newest non-superseded product delivery per work item, from one pass
 * over deliveries instead of one scan per work item.
 */
function currentProducts(
  deliveries: readonly Delivery[],
  ids: ReadonlySet<string>,
): Map<string, Delivery> {
  const byItem = new Map<string, Delivery[]>();
  for (const v of deliveries)
    if (
      ids.has(v.work_item_id) &&
      v.kind !== "card_completion" &&
      v.status !== "superseded"
    ) {
      const list = byItem.get(v.work_item_id);
      if (list) list.push(v);
      else byItem.set(v.work_item_id, [v]);
    }
  const current = new Map<string, Delivery>();
  for (const [id, list] of byItem) {
    const v = newestById(list);
    if (v) current.set(id, v);
  }
  return current;
}

/**
 * C-768: the one rule every merge gate (human, PM Ops, system) shares — only a
 * required verifier holds a merge. An optional one is listed for reference.
 * Waiving a required verifier stays guarded elsewhere: template items cannot
 * be made optional, and an independent review made optional hands the
 * confirmation to the human (`riskTagAutoMergeAllowed`, `mergeRiskBlockers`).
 */
export const mergeBlockingVerifier = (
  w: Pick<WorkItem, "kind" | "required">,
): boolean => w.kind === "verify" && w.required;

/**
 * §7.4: PM Ops may choose `merge` only when the merge gate passed for the
 * current completion, every non-cancelled required verify item passed and no
 * must_fix remains open. An empty list means merge is allowed;
 * otherwise PM Ops can only hold, request changes or hand the confirmation
 * to the human.
 */
export function pmMergeBlockers(
  state: CommandState,
  q: Decision,
  proofReads?: TestReviewProofRead[],
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
  const cardItemIds = new Set<string>();
  for (const w of state.work_items)
    if (w.card_id === q.card_id) cardItemIds.add(w.id);
  if (
    invalidTestReviewPasses(
      state,
      state.deliveries.filter(
        (v) => v.status !== "superseded" && cardItemIds.has(v.work_item_id),
      ),
      proofReads,
    ).length
  )
    blockers.push("增量复核的隔离证据已失效，须完整复核");
  blockers.push(...mergeRiskBlockers(state, context.value.card));
  const screenshot = screenshotCheckBlocker(state, context.value.card);
  if (screenshot) blockers.push(screenshot);
  const check = state.project_settings?.merge_queue
    ? passedCardCheck(state.events, card_id, completion.id)
    : latestMergeCheck(state.events, card_id, completion.id);
  if (check?.status !== "passed")
    blockers.push(
      check
        ? `合并闸门检查未通过（当前 ${check.status}）`
        : missingMergeCheckReason(
            state.project_settings?.merge_gate_enabled,
            state.events,
            card_id,
            completion.id,
          ),
    );
  const items = state.work_items.filter(
    (w) => w.card_id === card_id && w.status !== "cancelled",
  );
  for (const w of items.filter(mergeBlockingVerifier))
    if (w.status !== "passed") blockers.push(`验证项 ${w.id} 未通过`);
  const currentByItem = currentProducts(
    state.deliveries,
    new Set(items.map((w) => w.id)),
  );
  const current = items
    .map((w) => currentByItem.get(w.id))
    .filter((v): v is Delivery => !!v);
  for (const w of items.filter((w) => w.kind === "produce" && w.required))
    if (
      !current.some((v) => v.work_item_id === w.id && v.status === "accepted")
    )
      blockers.push(`产出项 ${w.id} 的最新交付未通过验收`);
  for (const v of [...current, completion]) {
    for (const id of v.requested_verifiers)
      if (
        items.some((w) => w.id === id && (w.kind !== "verify" || w.required)) &&
        !state.reviews.some(
          (r) =>
            r.work_item_id === id && reviewPassed(r) && !isReviewStale(r, v),
        )
      )
        blockers.push(`验证项 ${id} 未通过当前交付审核`);
    const latest = latestReviews(state, v);
    for (const r of latest.values())
      if (unresolvedMustFix(r))
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

/** The merge-blocker wording of one check that has not passed. */
export const preMergeCheckBlockerReason = (
  c: Pick<EffectivePreMergeCheck, "label" | "status" | "stale">,
): string =>
  `${c.label}：${c.status === "failed" ? "未通过" : "待核"}${c.stale ? "（当前交付需重新核对）" : ""}`;

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
    const currentByItem = currentProducts(
      state.deliveries,
      new Set(products.map((w) => w.id)),
    );
    // Artifact products are never merged, so they need no path evidence.
    if (
      products.some((w) => missingAutoRiskPathEvidence(currentByItem.get(w.id)))
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
        .map(preMergeCheckBlockerReason),
    ]),
  ];
}
