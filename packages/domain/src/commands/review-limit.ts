import type { Assignment, Decision, WorkItem } from "../entities.js";
import type { CommandDraft } from "./core.js";
import { endRun } from "./end-run.js";
import { currentReviewTarget } from "./review-round.js";

function hasActivePmOps(d: CommandDraft) {
  return d
    .list("assignments")
    .some(
      (a) =>
        a.status === "active" &&
        a.role_id === "pm" &&
        a.scope === "standing" &&
        a.standing_mode === "ops",
    );
}

/** Reassign pending process decisions in the same transaction as the last Ops leaves. */
export function handoffReviewLimitsWithoutOps(
  d: CommandDraft,
  assignment: Assignment,
) {
  if (
    assignment.scope !== "standing" ||
    assignment.role_id !== "pm" ||
    assignment.standing_mode !== "ops" ||
    hasActivePmOps(d)
  )
    return;
  const reason = `后台项目经理 ${assignment.id} 已${assignment.status === "suspended" ? "暂停" : "释放"}，项目已无活跃后台，审核上限拍板转交给你。`;
  for (const q of d.list("decisions")) {
    if (
      q.trigger !== "review_limit" ||
      q.decider !== "role:pm" ||
      !["open", "provisional"].includes(q.status)
    )
      continue;
    d.put("decisions", {
      ...q,
      decider: "human",
      context: `${q.context}\n\n${reason}`,
    });
    d.emit(
      "decision_requested",
      q.card_id,
      {
        decision_id: q.id,
        affected_work_items: [...q.affected_work_items],
        previous_decider: q.decider,
        assignment_id: assignment.id,
        reason,
      },
      { type: "decision_request", decision_id: q.id, body: reason },
    );
  }
}

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
  if (item.status !== "waiting_decision")
    d.put("work_items", d.move(item, "review_limit_exceeded"));
  const existing = pendingReviewLimit(d, item);
  const prior = d
    .list("reviews")
    .filter((r) => r.work_item_id === item.id)
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
  const conflictRepair = !!currentReviewTarget(d, item)
    ?.merge_conflict_event_id;
  const mustFix =
    prior?.issues.some((i) => i.must_fix && !i.pre_existing) ?? false;
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
  const decision: Decision = existing ?? {
    id,
    key: id,
    card_id: item.card_id,
    raised_by: d.author,
    kind: "choose",
    category: "general",
    trigger: "review_limit",
    question: `审核轮数已用完：${item.id}`,
    context: `已达到${item.kind === "verify" ? item.max_review_rounds : "当前"}轮审核上限，继续审核前需要拍板；上一轮结论为${verdict}${mustFix ? "，仍有必须修复的问题" : "，没有必须修复的问题"}。${reason}。`,
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
    affected_cards: [item.card_id],
    affected_work_items: [item.id],
    blocking: true,
    decider: hasActivePmOps(d) ? "role:pm" : "human",
    doc_refs: [],
    status: "open",
  };
  const runs = d
    .list("runs")
    .filter(
      (r) => r.assignment_id === item.assignment_id && r.status === "running",
    );
  for (const run of runs) endRun(d, run, "blocked", decision.question);
  if (existing) return;
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
}
