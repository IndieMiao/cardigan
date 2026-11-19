import {
  type Decision,
  type Review,
  reviewImpactLabel,
  type WorkItem,
} from "../entities.js";
import { sharedReviewers } from "../shared-findings.js";
import type { CommandDraft } from "./core.js";
import { assignDecision } from "./delegation.js";
import { endRun } from "./end-run.js";
import { applyFlowReviewLimit } from "./flow-review-limit.js";
import { REVIEW_LIMIT_PLAIN_SUMMARY } from "./plain-summary.js";
import { resumeWork } from "./resumption.js";
import { raiseVerifierLimit } from "./review-limit-resolution.js";
import {
  consecutiveReviewRejects,
  currentReviewTarget,
  reviewRejectionsNeedAttention,
} from "./review-round.js";

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

function sharedGroup(
  d: CommandDraft,
  review?: Review,
): Decision["review_limit_group"] {
  if (!review) return;
  const ids = review.issues
    .filter((i) => i.must_fix && !i.pre_existing)
    .map((i) => i.finding_id);
  if (!ids.length || !ids.every((id): id is string => !!id)) return;
  const target = d.get("deliveries", review.delivery_id);
  return {
    delivery_id: target.id,
    target_sha: review.target_sha,
    finding_ids: [...new Set(ids)].sort(),
    candidate_items: sharedReviewers(target, d.list("work_items")),
  };
}

// Both a final non-pass review and a new target with no remaining budget use this path.
export function requestReviewLimit(
  d: CommandDraft,
  item: WorkItem,
  review?: Review,
) {
  if (!reviewRejectionsNeedAttention(d, item))
    return applyFlowReviewLimit(d, item);
  const group = sharedGroup(d, review);
  const sibling =
    group &&
    d.list("decisions").find((q) => {
      const g = q.review_limit_group;
      return (
        q.trigger === "review_limit" &&
        q.card_id === item.card_id &&
        g?.delivery_id === group.delivery_id &&
        g.target_sha === group.target_sha &&
        g.candidate_items.includes(item.id) &&
        !q.affected_work_items.includes(item.id) &&
        g.finding_ids.length === group.finding_ids.length &&
        g.finding_ids.every((id, n) => id === group.finding_ids[n]) &&
        (["open", "snoozed", "provisional"].includes(q.status) ||
          (q.status === "resolved" && q.resolution?.option === "raise_limit"))
      );
    });
  if (item.status !== "waiting_decision")
    d.put("work_items", d.move(item, "review_limit_exceeded"));
  const existing = sibling ?? pendingReviewLimit(d, item);
  const prior = d
    .list("reviews")
    .filter((r) => r.work_item_id === item.id)
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
  const conflictRepair = !!currentReviewTarget(d, item)
    ?.merge_conflict_event_id;
  const mustFix =
    prior?.issues.some((i) => i.must_fix && !i.pre_existing) ?? false;
  const impacts = [
    ...new Set(
      prior?.issues.flatMap((i) =>
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
  const verdict = prior
    ? { pass: "通过", reject: "驳回", conditional: "有条件通过" }[prior.verdict]
    : "尚无结论";
  const reason = conflictRepair
    ? "最近一次交付是合并冲突修复，建议增加一轮审核额度以继续确认修复结果"
    : mustFix
      ? "上一轮仍有必须修复的问题，建议暂停并先确认后续处理方向"
      : "上一轮没有必须修复的问题，建议增加一轮审核额度以继续确认交付";
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
      ...(group ? { review_limit_group: group } : {}),
      question: `连续驳回 ${consecutiveReviewRejects(d, item)} 次，请 PM 排查：${item.id}${group ? `（${group.delivery_id}；${group.candidate_items.join("、")} 若因同一组必改项触发上限，共用本决定）` : ""}`,
      context: `同一验证项连续驳回超过 3 次，先由 PM 排查；PM 无法处理时再交人。上一轮结论为${verdict}${mustFix ? "，仍有必须修复的问题" : "，没有必须修复的问题"}。${impactSummary}${reason}。${group ? `必改项：${group.finding_ids.join("、")}。` : ""}`,
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
      ],
      recommended,
      plain_summary: { ...REVIEW_LIMIT_PLAIN_SUMMARY },
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
  if (decision.status !== "resolved")
    for (const run of runs)
      endRun(d, run, "blocked", decision.question, {
        reason: "review_limit",
        decision_id: id,
      });
  if (sibling && review) {
    const affected = [...sibling.affected_work_items, item.id];
    d.put("decisions", { ...sibling, affected_work_items: affected });
    d.emit(
      "review_limit_group_joined",
      item.card_id,
      {
        decision_id: sibling.id,
        work_item_id: item.id,
        review_id: review.id,
        affected_work_items: affected,
      },
      {
        type: "status_change",
        decision_id: sibling.id,
        work_item_id: item.id,
        body: `${item.id} 对同一组必改项的驳回共用 ${sibling.id}。`,
      },
    );
    if (sibling.status === "resolved" && sibling.resolution) {
      raiseVerifierLimit(
        d,
        d.work(item.id),
        sibling.id,
        sibling.resolution,
        sibling.resolution.resolved_by,
      );
      // This Run just submitted its verdict; the next delivery wakes the lane.
      resumeWork(d, d.work(item.id));
      return true;
    }
  }
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
