import {
  type Decision,
  reviewImpactLabel,
  type WorkItem,
} from "../entities.js";
import { type CommandDraft, ensure } from "./core.js";
import { assignDecision } from "./delegation.js";
import { endRun } from "./end-run.js";
import { applyFlowReviewLimit } from "./flow-review-limit.js";
import {
  currentReviewTarget,
  rejectionStreak,
  reviewRejectionsNeedAttention,
} from "./review-round.js";
import { strategyOptions, summarizeRejection } from "./review-strategy.js";

export function pendingReviewLimit(d: CommandDraft, item: WorkItem) {
  return d
    .list("decisions")
    .find(
      (q) =>
        q.trigger === "review_limit" &&
        ["open", "provisional"].includes(q.status) &&
        q.affected_work_items.includes(item.id),
    );
}

// Both a final non-pass review and a new target with no remaining budget use this path.
export function requestReviewLimit(d: CommandDraft, item: WorkItem) {
  if (!reviewRejectionsNeedAttention(d, item))
    return applyFlowReviewLimit(d, item);
  if (item.status !== "waiting_decision")
    d.put("work_items", d.move(item, "review_limit_exceeded"));
  const existing = pendingReviewLimit(d, item);
  const streak = rejectionStreak(d, item);
  const prior = streak[0];
  ensure(prior, "invariant_violation", "缺少连续驳回依据");
  const recent = streak.slice(0, 3).map(summarizeRejection);
  const repeated = recent[0]?.key === recent[1]?.key;
  const conflictRepair = !!currentReviewTarget(d, item)
    ?.merge_conflict_event_id;
  const mustFix = prior.issues.some((i) => i.must_fix && !i.pre_existing);
  const impacts = [
    ...new Set(
      prior.issues.flatMap((i) =>
        i.must_fix && !i.pre_existing && i.impact
          ? [reviewImpactLabel[i.impact]]
          : [],
      ),
    ),
  ];
  const impactSummary = impacts.length
    ? `影响程度：${impacts.join("、")}。`
    : "";
  const recommended = conflictRepair || !mustFix ? "raise_limit" : "pause";
  const reason = repeated
    ? "最近两次同类，推荐换做法或收窄范围；能独立跟进的部分可拆卡。"
    : "最近两次类别不同，请判断是继续还是暂停。";
  const id = existing?.id ?? d.ids.next(d.state.project_id, "decision");
  const decision: Decision =
    existing ??
    assignDecision(d, {
      id,
      key: id,
      card_id: item.card_id,
      raised_by: d.author,
      kind: "choose",
      category: "general",
      trigger: "review_limit",
      question: `连续驳回 ${streak.length} 次，请 PM 排查：${item.id}`,
      review_intervention: {
        review_id: prior.id,
        producer_id: d.get("deliveries", prior.delivery_id).work_item_id,
      },
      context: [
        `最近三次驳回（从新到旧）：`,
        ...recent.map((r) => `${r.id}【${r.category}】${r.summary}`),
        ...(impactSummary ? [impactSummary] : []),
        reason,
      ].join("\n"),
      options: [
        {
          key: "raise_limit",
          description: "增加轮数：增加一轮审核额度",
          impact: "确认后审核上限加一；没有其他阻塞时恢复审核。",
        },
        {
          key: "pause",
          description: "暂停：保持停止，不安排返工",
          impact: "保留当前阻塞，之后仍可选择增加审核轮数。",
        },
        ...(repeated ? strategyOptions : []),
      ],
      recommended: repeated ? "change_approach" : recommended,
      plain_summary: {
        changed: `同一项审核已连续被驳回 ${streak.length} 次`,
        impact: reason,
        risk: "在决定下一步之前，暂停返工。",
      },
      affected_cards: [item.card_id],
      affected_work_items: [item.id],
      blocking: true,
      decider: "human",
      doc_refs: [],
      status: "open",
    });
  const runs = d
    .list("runs")
    .filter(
      (r) => r.assignment_id === item.assignment_id && r.status === "running",
    );
  for (const run of runs)
    endRun(d, run, "blocked", decision.question, {
      reason: "review_limit",
      decision_id: id,
    });
  if (existing) return false;
  d.put("decisions", decision);
  d.emit(
    "decision_requested",
    item.card_id,
    { decision_id: id, affected_work_items: [item.id] },
    {
      type: "decision_request",
      body: decision.question,
      decision_id: id,
      work_item_id: item.id,
      ...(runs[0] ? { run_id: runs[0].id } : {}),
    },
  );
  return false;
}
