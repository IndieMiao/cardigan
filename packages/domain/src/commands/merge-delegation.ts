import { isReviewStale } from "../derived.js";
import type { Decision, Delivery } from "../entities.js";
import { pmMergeConfirmation } from "../preferences.js";
import { attempt, type CommandState } from "./core.js";
import { mergeRequiresHuman } from "./delegation.js";
import { mergeContext } from "./merge.js";
import {
  failedConfirmedMergeCheck,
  failedCurrentMergeCheck,
  latestMergeCheck,
} from "./merge-check.js";

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
    // A later review from the same verifier replaces its earlier verdict.
    const latest = new Map<string, (typeof state.reviews)[number]>();
    for (const r of state.reviews)
      if (r.delivery_id === v.id && !isReviewStale(r, v)) {
        const seen = latest.get(r.work_item_id);
        if (!seen || Number(r.id.slice(2)) > Number(seen.id.slice(2)))
          latest.set(r.work_item_id, r);
      }
    for (const r of latest.values())
      if (r.issues.some((i) => i.must_fix && !i.pre_existing))
        blockers.push(`审核 ${r.id} 有未处理的 must_fix`);
  }
  return [...new Set(blockers)];
}

/**
 * §7.4 / P2a-1 §2.6: a merge confirmation whose current check failed or timed
 * out that PM Ops may return (`request_changes`) or recheck — the PM-held open
 * confirmation, or any confirmed merge (human, PM or timeout) whatever its
 * decider. D12 / scope-change cards and confirmations handed to the human
 * (`human_required_reason`) stay with the human.
 */
export function pmFailedMergeCheck(state: CommandState, q: Decision) {
  if (!pmMergeCheckDelegationAllowed(state, q)) return undefined;
  if (q.status === "resolved") return failedConfirmedMergeCheck(state, q);
  return q.decider === "role:pm" && ["open", "provisional"].includes(q.status)
    ? failedCurrentMergeCheck(state, q)
    : undefined;
}
/** Shared by command authorization, queues and routing; read the current preference. */
export function pmMergeCheckDelegationAllowed(
  state: Pick<
    CommandState,
    "project_id" | "project_preferences" | "cards" | "decisions"
  >,
  q: Decision,
) {
  return (
    q.trigger === "merge_confirmation" &&
    pmMergeConfirmation(
      state.project_preferences?.find((p) => p.id === state.project_id),
    ) &&
    !mergeRequiresHuman(state, q)
  );
}
/** Policy evidence recorded when PM Ops handles a failed merge check. */
export const pmMergeCheckFailureAuthority = (project_id: string) =>
  `project:${project_id}/pm-ops-merge-check-failure`;
