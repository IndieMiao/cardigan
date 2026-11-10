import type { Card, Decision, Delivery } from "../entities.js";
import { transition } from "../transitions.js";
import { type CommandDraft, ensure, unwrap } from "./core.js";
import { assignDecision } from "./delegation.js";
import { completionPassed } from "./merge.js";
import { resolveCardTemplate } from "./templates.js";

/** A human Decider reviews a version-bound approval in the existing decision flow. */
export function requestHumanCompletionReview(
  d: CommandDraft,
  card: Card,
  delivery: Delivery,
): void {
  const template = resolveCardTemplate(d, card);
  if (
    template.completion.mode !== "review" ||
    template.completion.reviewer !== "human"
  )
    return;
  // A replacement request withdraws the old human review, just as verifier targets do.
  for (const old of d.list("decisions")) {
    if (
      old.card_id === card.id &&
      old.trigger === "completion_review" &&
      ["open", "provisional"].includes(old.status)
    )
      d.put("decisions", {
        ...old,
        status: unwrap(transition("decision", old.status, "supersede")),
      });
  }
  const id = d.ids.next(d.state.project_id, "decision");
  const decision: Decision = assignDecision(d, {
    id,
    key: id,
    card_id: card.id,
    raised_by: "system",
    kind: "approve",
    trigger: "completion_review",
    category: "feature_detail",
    target: { delivery_id: delivery.id },
    question: `验收 ${card.id} 的完成申请 ${delivery.id}`,
    context: delivery.summary,
    options: [
      { key: "approve", description: "验收通过", impact: "进入合并或完成" },
      { key: "reject", description: "退回修改", impact: "重新提交完成申请" },
    ],
    recommended: "approve",
    affected_cards: [card.id],
    affected_work_items: [delivery.work_item_id],
    blocking: false,
    decider: "human",
    doc_refs: [],
    status: "open",
  });
  d.put("decisions", decision);
  d.emit(
    "decision_requested",
    card.id,
    { decision_id: id, affected_work_items: [] },
    { type: "decision_request", decision_id: id, body: decision.question },
  );
}
export function resolveHumanCompletionReview(
  d: CommandDraft,
  decision: Decision,
  option: string,
): void {
  ensure(
    decision.kind === "approve" &&
      "delivery_id" in decision.target &&
      decision.card_id,
    "invariant_violation",
    "完成验收必须绑定交付",
  );
  const delivery = d.get("deliveries", decision.target.delivery_id);
  const card = d.card(decision.card_id);
  ensure(
    !d.assignment ||
      !d
        .list("runs")
        .some(
          (r) =>
            r.id === delivery.run_id && r.assignment_id === d.assignment?.id,
        ),
    "unauthorized",
    "The author cannot approve their own completion request",
  );
  const template = resolveCardTemplate(d, card);
  ensure(
    template.completion.mode === "review" &&
      template.completion.reviewer === "human" &&
      delivery.kind === "card_completion" &&
      delivery.status === "submitted" &&
      card.status === "review",
    "stale_target",
    "完成申请已失效",
  );
  d.put("deliveries", {
    ...delivery,
    status: unwrap(
      transition(
        "delivery",
        delivery.status,
        option === "approve" ? "accept" : "reject",
      ),
    ),
  });
  d.emit("completion_reviewed", card.id, {
    decision_id: decision.id,
    delivery_id: delivery.id,
    verdict: option === "approve" ? "pass" : "reject",
    rework_allowed: option === "reject",
  });
  if (option === "approve") completionPassed(d, card, delivery);
  else
    d.put("cards", {
      ...card,
      status: unwrap(
        transition("card", card.status, "completion_review_rejected"),
      ),
    });
}
