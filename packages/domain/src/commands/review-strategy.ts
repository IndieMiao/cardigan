import type { Decision, Review, TimelineEntry, WorkItem } from "../entities.js";
import type { DecisionId, WorkItemId } from "../ids.js";
import { type CommandDraft, ensure } from "./core.js";
import { checkEmployeeSeparation } from "./employee-assignment.js";

export const strategyOptions = [
  {
    key: "change_approach",
    description: "换做法",
    impact: "作者先在卡上提交新方案，审核员确认方向后才能改代码。",
  },
  {
    key: "narrow_scope",
    description: "收窄范围",
    impact: "请在理由中写明本轮移出的范围；剩余内容仍需正式审核。",
  },
  {
    key: "split_card",
    description: "拆卡",
    impact: "先以本决定为来源创建承接未完成部分的后续卡；原卡只继续剩余工作。",
  },
] as const;

const categories: readonly [RegExp, string][] = [
  [
    /并发|竞态|时序|顺序|旧快照|写回|race condition|stale (read|write|snapshot)/iu,
    "并发时序",
  ],
  [/权限|越权|鉴权|authorization|permission/iu, "权限边界"],
  [/数值|舍入|溢出|rounding|overflow/iu, "数值边界"],
  [/测试|覆盖率|coverage|\btest(s|ing)?\b/iu, "测试覆盖"],
  [/验收|需求|requirement/iu, "需求与验收"],
];
export function summarizeRejection(review: Review) {
  const reason = review.issues
    .filter((i) => i.must_fix && !i.pre_existing)
    .map((i) => i.description.trim())
    .join("；")
    .replace(/\s+/gu, " ");
  const category =
    review.rejection_category ??
    categories.find(([pattern]) => pattern.test(reason))?.[1];
  return {
    id: review.id,
    category: category ?? "其他",
    key: category?.toLowerCase() ?? `其他：${reason || review.id}`,
    summary: reason.length > 160 ? `${reason.slice(0, 159)}…` : reason,
  };
}

function instruct(
  d: CommandDraft,
  item: WorkItem,
  decision: DecisionId,
  body: string,
) {
  d.emit(
    "instruction_issued",
    item.card_id,
    { work_item_id: item.id, decision_id: decision },
    { type: "instruction", work_item_id: item.id, decision_id: decision, body },
  );
}

export function applyReviewStrategy(
  d: CommandDraft,
  q: Decision,
  option: string,
  rationale: string,
) {
  const bound = q.review_intervention;
  ensure(
    bound && q.options.some((o) => o.key === option),
    "validation_failed",
    "该拍板未提供此选项",
  );
  const producer = d.work(bound.producer_id);
  const card = d.card(producer.card_id);
  if (option === "change_approach") {
    instruct(
      d,
      producer,
      q.id,
      `${q.id} 换做法：${rationale}。先用 post_comment 的 review_plan={decision_id:"${q.id}",step:"propose"} 在本卡提交新方案；收到对应审核员确认指令后再改代码。`,
    );
    return;
  }
  const followups =
    option === "split_card"
      ? d
          .list("cards")
          .filter(
            (c) =>
              c.project_id === card.project_id &&
              c.id !== card.id &&
              c.status !== "cancelled" &&
              c.source.kind === "decision" &&
              c.source.decision_id === q.id,
          )
      : [];
  ensure(
    option !== "split_card" || followups.length > 0,
    "validation_failed",
    "请先以本决定为来源创建承接未完成部分的后续卡",
  );
  const scope = followups.length
    ? `转至 ${followups.map((c) => c.id).join("、")}：${rationale}`
    : rationale;
  d.put("cards", {
    ...card,
    out_of_scope: [...card.out_of_scope, scope],
    related_cards: [
      ...new Set([...card.related_cards, ...followups.map((c) => c.id)]),
    ],
  });
  instruct(
    d,
    producer,
    q.id,
    `${q.id} 本轮范围移出：${scope}。剩余内容仍需重新交付审核。`,
  );
}

export function checkReviewPlanGate(
  d: CommandDraft,
  producer: WorkItem,
  verifierId?: WorkItemId,
) {
  const gate = d
    .list("decisions")
    .find(
      (q) =>
        q.card_id === producer.card_id &&
        (!verifierId || q.affected_work_items.includes(verifierId)) &&
        q.review_intervention?.producer_id === producer.id &&
        q.status === "resolved" &&
        q.resolution?.option === "change_approach" &&
        !q.review_intervention.confirmation,
    );
  ensure(
    !gate,
    "illegal_transition",
    `返工等待审核员确认方案方向：${gate?.id}`,
  );
}

export type ReviewPlanComment = {
  decision_id: DecisionId;
  step: "propose" | "confirm";
};
export function recordReviewPlan(
  d: CommandDraft,
  entry: TimelineEntry,
  p: ReviewPlanComment,
) {
  const q = d.get("decisions", p.decision_id);
  const bound = q.review_intervention;
  const verifierId = q.affected_work_items[0];
  ensure(
    q.card_id === entry.card_id &&
      q.status === "resolved" &&
      q.trigger === "review_limit" &&
      q.resolution?.option === "change_approach" &&
      bound &&
      !bound.confirmation &&
      verifierId,
    "illegal_transition",
    "没有等待方案或方向确认的换做法决定",
  );
  const producer = d.work(bound.producer_id),
    verifier = d.work(verifierId);
  ensure(
    !["done", "cancelled", "awaiting_merge"].includes(
      d.card(entry.card_id).status,
    ) &&
      verifier.status !== "cancelled" &&
      !verifier.replaced_by_work_item_id,
    "illegal_transition",
    "工作项已关闭或替换",
  );
  if (p.step === "propose") {
    d.ownWork(producer.id);
    d.put("decisions", {
      ...q,
      review_intervention: { ...bound, proposal: entry.id },
    });
    instruct(
      d,
      verifier,
      q.id,
      `${q.id} 请阅读方案 ${entry.id}；同意方向时用 post_comment 回复该条（reply_to），并传 review_plan={decision_id:"${q.id}",step:"confirm"}。不同意请说明需调整之处，不作确认。`,
    );
  } else {
    d.ownWork(verifier.id);
    const proposal = d.state.timeline.find((t) => t.id === bound.proposal);
    ensure(
      p.step === "confirm" &&
        proposal &&
        !proposal.retracted &&
        !d.state.timeline.some((t) => t.supersedes === proposal.id) &&
        entry.reply_to === proposal.id &&
        proposal.author !== entry.author,
      "validation_failed",
      "请回复作者当前提交的方案",
    );
    checkEmployeeSeparation(
      d,
      verifier,
      d.assignment?.employee_id,
      d.get("deliveries", d.get("reviews", bound.review_id).delivery_id),
    );
    d.put("decisions", {
      ...q,
      review_intervention: { ...bound, confirmation: entry.id },
    });
    instruct(
      d,
      producer,
      q.id,
      `${q.id} 审核员已确认方案 ${proposal.id}，请按该方向修改并重新交付；方向确认不是审核通过。`,
    );
  }
}
