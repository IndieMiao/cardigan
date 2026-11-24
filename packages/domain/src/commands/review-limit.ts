import {
  type Decision,
  type Review,
  reviewImpactLabel,
  type WorkItem,
} from "../entities.js";
import { flowAtLeast } from "../flow.js";
import { streakAlignment } from "../review-convergence.js";
import { originalRunTrigger } from "../run-trigger.js";
import { sharedReviewers } from "../shared-findings.js";
import { reviewDiscussionInstruction } from "../shared-review-wake.js";
import { type CommandDraft, ensure } from "./core.js";
import { assignDecision } from "./delegation.js";
import { endRun } from "./end-run.js";
import { applyFlowReviewLimit } from "./flow-review-limit.js";
import { resumeWork } from "./resumption.js";
import { raiseVerifierLimit } from "./review-limit-resolution.js";
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
  if (!pendingReviewLimit(d, item) && openReviewAlignment(d, item))
    return false;
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
          (q.status === "resolved" &&
            !!q.resolution &&
            q.resolution.option !== "pause"))
      );
    });
  if (item.status !== "waiting_decision")
    d.put("work_items", d.move(item, "review_limit_exceeded"));
  const existing = sibling ?? pendingReviewLimit(d, item);
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
  const alignment = streakAlignment(item, streak);
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
      ...(group ? { review_limit_group: group } : {}),
      question: `连续驳回 ${streak.length} 次，请 PM 排查：${item.id}`,
      review_intervention: {
        review_id: prior.id,
        producer_id: d.get("deliveries", prior.delivery_id).work_item_id,
      },
      context: [
        `最近三次驳回（从新到旧）：`,
        ...recent.map((r) => `${r.id}【${r.category}】${r.summary}`),
        ...(impactSummary ? [impactSummary] : []),
        ...(alignment?.status === "disputed"
          ? [
              `作者与审核员对齐不变量未达成一致：提案 ${alignment.proposal?.entry_id ?? "无"}，分歧 ${alignment.reply_entry_id ?? "无"}。`,
            ]
          : []),
        reason,
        ...(group
          ? [
              `${group.delivery_id} 必改项：${group.finding_ids.join("、")}；两路相同驳回共用本决定。`,
            ]
          : []),
      ].join("\n"),
      options: [
        {
          key: "raise_limit",
          description: "增加轮数：增加一轮审核额度",
          impact: "确认后审核上限加一；没有其他阻塞时恢复审核。",
        },
        {
          key: "pause",
          description: "暂停返工，指定方案负责人和待确认人",
          impact: "保留阻塞；跟进方案与确认，复查逾期提醒 PM。",
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
  if (decision.status !== "resolved")
    for (const run of runs)
      if (
        item.status !== "waiting_decision" ||
        !reviewDiscussionInstruction(
          item,
          originalRunTrigger(d.state, run),
          d.state,
        )
      )
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
      // The resolution already woke the producer (or issued a strategy instruction).
      return false;
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

/**
 * C-610 (flow >= 5): the third consecutive rejection opens an alignment round
 * between author and verifier instead of a PM decision. Only a disputed round
 * falls through to PM.
 */
function openReviewAlignment(d: CommandDraft, item: WorkItem): boolean {
  if (item.kind !== "verify" || !flowAtLeast(d.card(item.card_id), 5))
    return false;
  const streak = rejectionStreak(d, item);
  const current = streakAlignment(item, streak);
  if (current) return current.status === "open";
  // Longer streaks without a round predate C-610 and keep the PM path.
  if (streak.length !== 3) return false;
  const latest = streak[0];
  ensure(latest, "invariant_violation", "缺少连续驳回依据");
  const producer = d.work(d.get("deliveries", latest.delivery_id).work_item_id);
  const waiting =
    item.status === "waiting_decision"
      ? item
      : d.move(item, "review_limit_exceeded");
  ensure(waiting.kind === "verify", "invariant_violation", "需要验证项");
  d.put("work_items", {
    ...waiting,
    review_alignment: { review_id: latest.id, status: "open" },
  });
  d.emit(
    "review_alignment_opened",
    item.card_id,
    {
      work_item_id: item.id,
      producer_id: producer.id,
      review_id: latest.id,
      streak: streak.length,
    },
    {
      type: "system",
      author: "system",
      work_item_id: item.id,
      body: `${item.id} 已连续驳回 ${streak.length} 次，系统开启作者与审核员的对齐回合：先对齐不变量清单，再继续审核。`,
    },
    { kind: "system", project_id: d.state.project_id },
  );
  d.emit(
    "instruction_issued",
    item.card_id,
    { work_item_id: producer.id, alignment_work_item_id: item.id },
    {
      type: "instruction",
      author: "system",
      work_item_id: producer.id,
      body: `对齐回合：${item.id} 已连续驳回 ${streak.length} 次。先用 get_card 读最近的驳回，再用 post_comment 的 review_alignment={work_item_id:"${item.id}",step:"propose",invariants:[...]} 提出 1–10 条本卡必须守住的不变量；审核员确认后系统恢复审核，之后的必改项只能引用这些不变量或通过条件清单。可同时继续修改和交付。`,
    },
    { kind: "system", project_id: d.state.project_id },
  );
  return true;
}
