import { isReviewStale, reviewPassed } from "../derived.js";
import type { Actor, Review, WorkItem } from "../entities.js";
import { appendEvents, eventsOfType } from "../event-index.js";
import type { WorkItemId } from "../ids.js";
import { mergeBatches } from "../merge-batch.js";
import { transition } from "../transitions.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  ensure,
  unwrap,
} from "./core.js";
import { isPmOps } from "./delegation.js";
import { lateEvidence } from "./late-evidence.js";
import { syncRiskTagMerge } from "./merge.js";
import { latestMergeCheck } from "./merge-check.js";
import { withdrawIndependentReviewCheck } from "./pre-merge-checks.js";
import { commandWithReadyVerifiers as command } from "./system-rules.js";

export interface WithdrawReviewParams {
  readonly work_item_id: WorkItemId;
  readonly rationale: string;
}

/**
 * C-769: void a rejection the reviewer made before evidence that had already
 * reached the delivery was read. Only the rejection's own reviewer or PM Ops
 * may do it, and only while evidence demonstrably arrived between the start of
 * the review Run and the rejection. The record stays for audit; the delivery
 * awaits review again, the author need not resubmit, and the rejection spends
 * no round (see voidedRejection).
 */
function voidRejection(
  d: CommandDraft,
  item: WorkItem,
  rationale: string,
): Review {
  const card = d.card(item.card_id);
  ensure(
    !d.state.events.some(
      (e) => e.card_id === card.id && e.type === "card_merged",
    ),
    "illegal_transition",
    "卡片已经合并，不能作废驳回",
  );
  const review = d
    .list("reviews")
    .filter((r) => r.work_item_id === item.id)
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
  ensure(
    review?.verdict === "reject" && review.blocking && !review.withdrawn,
    "stale_target",
    "没有可作废的当前驳回",
  );
  const run = d.get("runs", review.run_id);
  ensure(
    isPmOps(d) || run.assignment_id === d.assignment?.id,
    "unauthorized",
    "只有提交该驳回的审核员或常驻 PM 可以作废驳回",
  );
  const delivery = d.get("deliveries", review.delivery_id);
  ensure(
    delivery.kind !== "card_completion",
    "illegal_transition",
    "完成验收的驳回不能作废",
  );
  ensure(
    delivery.status === "rejected" &&
      delivery.subject.value === review.target_sha &&
      !d
        .list("deliveries")
        .some(
          (v) =>
            v.work_item_id === delivery.work_item_id &&
            v.kind !== "card_completion" &&
            Number(v.id.slice(2)) > Number(delivery.id.slice(2)),
        ),
    "stale_target",
    "作者已提交新交付，这次驳回已过期，不能作废",
  );
  const events = appendEvents(d.state.events, d.events);
  const submitted = eventsOfType(events, "review_submitted").find(
    (e) =>
      (e.payload as { review_id?: unknown } | null)?.review_id === review.id,
  );
  ensure(submitted, "stale_target", "找不到这次驳回的提交记录");
  const late = lateEvidence(d, run, delivery, submitted);
  ensure(
    late.length > 0,
    "illegal_transition",
    "只能作废因证据晚到而误判的驳回：审核开始到驳回提交之间，交付没有新到的证据附件",
  );
  ensure(
    !d
      .list("reviews")
      .some(
        (r) =>
          r.delivery_id === delivery.id &&
          r.work_item_id !== item.id &&
          r.blocking &&
          !r.withdrawn,
      ),
    "illegal_transition",
    "这次交付还有其它审核项的有效驳回，作者仍需修改，不能作废",
  );
  const producer = d.work(delivery.work_item_id);
  ensure(
    producer.status === "changes_requested" ||
      producer.status === "in_progress",
    "illegal_transition",
    "作者已转入阻塞或等待拍板，暂不能作废驳回",
  );
  const voided: Review = {
    ...review,
    withdrawn: { at: d.now, rationale, by: d.author, late_evidence: late },
  };
  d.put("reviews", voided);
  d.put("work_items", d.move(item, "rejection_withdrawn"));
  d.put("deliveries", {
    ...delivery,
    status: unwrap(
      transition("delivery", delivery.status, "rejection_withdrawn"),
    ),
  });
  d.put("work_items", d.move(producer, "rejection_withdrawn"));
  d.emit(
    "review_withdrawn",
    card.id,
    {
      review_id: review.id,
      work_item_id: item.id,
      rationale,
      verdict: review.verdict,
      delivery_id: delivery.id,
      producer_work_item_id: producer.id,
      late_evidence: late,
      // Only a later running Run of the reviewer can review the delivery
      // again by itself; otherwise the Router wakes a new review Run.
      reviewer_needs_run: !d
        .list("runs")
        .some(
          (r) =>
            r.assignment_id === run.assignment_id &&
            r.status === "running" &&
            r.id !== run.id,
        ),
    },
    {
      type: "system",
      body: `${isPmOps(d) && run.assignment_id !== d.assignment?.id ? "常驻 PM" : "审核方"}作废了驳回：驳回前交付已到证据 ${late.join("、")}，审核读到的是更早的卡片。${delivery.id} 恢复待审，作者无需重交，这次驳回不计入审核轮数。理由：${rationale}`,
      work_item_id: item.id,
      delivery_id: delivery.id,
      refs: [{ kind: "review", id: review.id }],
    },
  );
  if (d.assignment?.role_id === "independent_reviewer") {
    withdrawIndependentReviewCheck(d, review);
    syncRiskTagMerge(d, card);
  }
  return voided;
}

/** P2a-11 card 1: ordinary review withdrawal, before downstream cascades. */
export function withdrawReview(
  state: CommandState,
  actor: Actor,
  p: WithdrawReviewParams,
  ports: CommandPorts,
) {
  return command(state, actor, "withdraw_review", ports, (d): Review => {
    ensure(
      actor.kind === "assignment",
      "unauthorized",
      "只有持有该验证项的 Assignment 本人可以撤回审核",
    );
    // C-769: PM Ops may void a late-evidence rejection; passes stay owner-only.
    const target = d.work(p.work_item_id);
    const item =
      target.kind === "verify" && target.status === "failed" && isPmOps(d)
        ? target
        : d.ownWork(p.work_item_id);
    ensure(item.kind === "verify", "unauthorized", "只能撤回验证工作项的审核");
    ensure(
      item.status === "passed" || item.status === "failed",
      "illegal_transition",
      "只能撤回当前已通过的审核，或作废因证据晚到而误判的驳回",
    );
    ensure(
      typeof p.rationale === "string" && p.rationale.trim().length > 0,
      "validation_failed",
      "撤回审核必须填写理由",
    );
    const card = d.card(item.card_id);
    ensure(
      !mergeBatches(state.events).some(
        (b) =>
          (b.status === "publishing" || b.check?.status === "running") &&
          !["published", "aborted", "resolved"].includes(b.status) &&
          b.members.some((m) => m.card_id === card.id),
      ),
      "illegal_transition",
      "批次正在检查或发布，不能撤回审核",
    );
    ensure(
      !["done", "cancelled"].includes(card.status),
      "illegal_transition",
      "已完成或已取消的卡片不能撤回审核",
    );
    if (item.status === "failed") return voidRejection(d, item, p.rationale);
    const review = d
      .list("reviews")
      .filter((r) => r.work_item_id === item.id)
      .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
    ensure(review, "stale_target", "没有当前有效的已通过审核");
    const delivery = d
      .list("deliveries")
      .filter(
        (v) =>
          v.requested_verifiers.includes(item.id) && !isReviewStale(review, v),
      )
      .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
    ensure(
      delivery &&
        reviewPassed(review) &&
        !isReviewStale(review, delivery) &&
        !d.list("deliveries").some((v) => v.supersedes === delivery.id),
      "stale_target",
      "审核已过期或已撤回，不能撤回历史审核",
    );
    // Completion withdrawal needs the atomic cascade supplied by P2a-11 card 3.
    ensure(
      delivery.kind !== "card_completion",
      "illegal_transition",
      "完成验收的撤回需完成申请级联支持，当前只支持普通验证项",
    );
    const completions = d
      .list("deliveries")
      .filter(
        (v) =>
          v.kind === "card_completion" &&
          v.status !== "superseded" &&
          d.get("work_items", v.work_item_id).card_id === card.id,
      );
    ensure(
      !completions.some(
        (v) =>
          latestMergeCheck(state.events, card.id, v.id)?.status === "running",
      ),
      "illegal_transition",
      "合并检查正在运行，暂不能撤回",
    );
    ensure(
      !state.events.some(
        (e) => e.card_id === card.id && e.type === "card_merged",
      ),
      "illegal_transition",
      "卡片已经合并，不能撤回审核",
    );
    const withdrawn: Review = {
      ...review,
      withdrawn: { at: d.now, rationale: p.rationale },
    };
    d.put("reviews", withdrawn);
    d.put("work_items", d.move(item, "withdraw_pass"));
    d.emit(
      "review_withdrawn",
      card.id,
      { review_id: review.id, work_item_id: item.id, rationale: p.rationale },
      {
        type: "system",
        body: `验证方撤回了审核：${p.rationale}`,
        work_item_id: item.id,
        delivery_id: delivery.id,
        refs: [{ kind: "review", id: review.id }],
      },
    );
    if (d.assignment?.role_id === "independent_reviewer") {
      withdrawIndependentReviewCheck(d, review);
      syncRiskTagMerge(d, card);
    }
    return withdrawn;
  });
}
