import { isReviewStale } from "../derived.js";
import type { Actor, Review } from "../entities.js";
import type { WorkItemId } from "../ids.js";
import { type CommandPorts, type CommandState, ensure } from "./core.js";
import { syncRiskTagMerge } from "./merge.js";
import { latestMergeCheck } from "./merge-check.js";
import { withdrawIndependentReviewCheck } from "./pre-merge-checks.js";
import { commandWithReadyVerifiers as command } from "./system-rules.js";

export interface WithdrawReviewParams {
  readonly work_item_id: WorkItemId;
  readonly rationale: string;
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
    const item = d.ownWork(p.work_item_id);
    ensure(item.kind === "verify", "unauthorized", "只能撤回验证工作项的审核");
    ensure(
      item.status === "passed",
      "illegal_transition",
      "只能撤回当前已通过的审核",
    );
    ensure(
      typeof p.rationale === "string" && p.rationale.trim().length > 0,
      "validation_failed",
      "撤回审核必须填写理由",
    );
    const card = d.card(item.card_id);
    ensure(
      !["done", "cancelled"].includes(card.status),
      "illegal_transition",
      "已完成或已取消的卡片不能撤回审核",
    );
    const review = d
      .list("reviews")
      .filter((r) => r.work_item_id === item.id)
      .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
    ensure(review, "stale_target", "没有当前有效的已通过审核");
    const delivery = d.get("deliveries", review.delivery_id);
    ensure(
      review.verdict === "pass" &&
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
