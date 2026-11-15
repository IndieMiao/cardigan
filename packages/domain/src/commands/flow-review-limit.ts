import type { WorkItem } from "../entities.js";
import { flowAtLeast } from "../flow.js";
import { validSystemReviewLimitMax } from "../system-review-limit.js";
import { CommandDraft, ensure } from "./core.js";
import { endRun } from "./end-run.js";
import { projectPreferences } from "./preferences.js";
import { resumeWork } from "./resumption.js";
import { currentReviewTarget, reviewRound } from "./review-round.js";

/** Shared lifetime budget: a flow upgrade never resets C-239 consumption. */
export function systemReviewLimitRaises(d: CommandDraft, item: WorkItem) {
  return [...d.state.events, ...d.events].filter(
    (e) =>
      e.actor.kind === "system" &&
      ["system_review_limit_raised", "review_limit_raised_by_system"].includes(
        e.type,
      ) &&
      (e.payload as Record<string, unknown>).work_item_id === item.id,
  ).length;
}

function apply(d: CommandDraft, id: WorkItem["id"], source: string) {
  let item = d.get("work_items", id);
  const card = d.get("cards", item.card_id);
  if (
    item.kind !== "verify" ||
    item.role_id === "independent_reviewer" ||
    !flowAtLeast(card, 5) ||
    ["done", "cancelled", "awaiting_merge"].includes(card.status) ||
    item.status === "cancelled" ||
    item.replaced_by_work_item_id
  )
    return false;

  // Old unanswered ordinary questions are replaced, never answered on behalf of a person.
  // Historical resolved decisions and every independent-review question remain intact.
  for (const q of d.list("decisions")) {
    if (
      q.card_id === card.id &&
      q.trigger === "review_limit" &&
      ["open", "provisional"].includes(q.status) &&
      q.affected_work_items.length === 1 &&
      q.affected_work_items[0] === item.id
    ) {
      d.put("decisions", { ...q, status: "superseded" });
      d.emit(
        "decision_superseded",
        card.id,
        {
          decision_id: q.id,
          work_item_id: item.id,
          reason: "flow_upgrade",
          rule: "flow-v2/B2",
        },
        {
          type: "system",
          author: "system",
          work_item_id: item.id,
          decision_id: q.id,
          body: "普通审核上限拍板已被新版流程取代；独立复核拍板不变。",
        },
      );
    }
  }
  const target = currentReviewTarget(d, item);
  if (!target) return false;
  const round = reviewRound(d, item, target);
  if (round <= item.max_review_rounds) {
    const resumed = resumeWork(d, item);
    if (resumed)
      d.emit(
        "review_limit_resumed_by_system",
        card.id,
        {
          work_item_id: item.id,
          delivery_id: target.id,
          round,
          max_review_rounds: item.max_review_rounds,
          source,
          rule: "flow-v2/B2",
          resume_work_items: [item.id],
        },
        {
          type: "system",
          author: "system",
          work_item_id: item.id,
          body: "普通审核已有足够额度，系统恢复当前交付的处理，不消耗自动加轮次数。",
        },
      );
    return true;
  }
  const used = systemReviewLimitRaises(d, item);
  const max = projectPreferences(d.state).system_review_limit_max_raises;
  const allowed =
    typeof max === "number" &&
    validSystemReviewLimitMax(max) &&
    used < max &&
    Number.isSafeInteger(item.max_review_rounds + 1) &&
    round === item.max_review_rounds + 1;
  if (!allowed) {
    if (item.status !== "waiting_decision") {
      item = d.move(item, "review_limit_exceeded");
      d.put("work_items", item);
    }
    for (const run of d.list("runs"))
      if (run.assignment_id === item.assignment_id && run.status === "running")
        endRun(
          d,
          run,
          "blocked",
          "普通审核自动加轮额度不可用，等待项目经理排查",
        );
    // Delivery + round identifies this wait across retries, concurrent transactions and restarts.
    if (
      ![...d.state.events, ...d.events].some(
        (e) =>
          e.actor.kind === "system" &&
          e.type === "review_limit_auto_raise_exhausted" &&
          (e.payload as Record<string, unknown>).work_item_id === item.id &&
          (e.payload as Record<string, unknown>).delivery_id === target.id &&
          (e.payload as Record<string, unknown>).round === round,
      )
    )
      d.emit(
        "review_limit_auto_raise_exhausted",
        card.id,
        {
          work_item_id: item.id,
          delivery_id: target.id,
          round,
          used_raises: used,
          max_raises:
            typeof max === "number" && validSystemReviewLimitMax(max) ? max : 0,
          rule: "flow-v2/B2",
        },
        {
          type: "system",
          author: "system",
          work_item_id: item.id,
          body: "普通审核自动加轮额度未设置或已用完，保持等待；请项目经理排查，不生成拍板。",
        },
      );
    return false;
  }
  const limit = item.max_review_rounds + 1;
  d.put("work_items", { ...item, max_review_rounds: limit });
  const resumed = resumeWork(d, d.get("work_items", item.id));
  const event = d.emit(
    "review_limit_raised_by_system",
    card.id,
    {
      work_item_id: item.id,
      delivery_id: target.id,
      round,
      previous_max_review_rounds: item.max_review_rounds,
      max_review_rounds: limit,
      used_raises: used + 1,
      max_raises: max as number,
      rule: "flow-v2/B2",
      source,
      resume_work_items: resumed ? [item.id] : [],
    },
    {
      type: "system",
      author: "system",
      work_item_id: item.id,
      body: `系统增加一轮普通审核额度，上限为 ${limit} 轮；累计自动加轮 ${used + 1} 次，仍须审核。`,
    },
  );
  const run = d
    .list("runs")
    .filter((r) => r.assignment_id === item.assignment_id)
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
  if (run)
    d.put("runs", {
      ...run,
      review_limit_changes: [
        ...(run.review_limit_changes ?? []),
        {
          event_id: event.id,
          max_review_rounds: limit,
          actor: "system",
          at: event.created_at,
        },
      ],
    });
  return true;
}

/** Internal rule, derived only inside an authenticated delivery/review/upgrade transaction. */
export function applyFlowReviewLimit(d: CommandDraft, item: WorkItem): boolean {
  ensure(
    [
      "submit_delivery",
      "submit_review",
      "upgrade_card_flow",
      "request_recheck",
    ].includes(d.tool),
    "unauthorized",
    "Only workflow settlement derives ordinary review rounds",
  );
  const system = new CommandDraft(
    { ...d.state, events: [...d.state.events, ...d.events] },
    { kind: "system", project_id: d.state.project_id },
    "system_review_limit",
    d.ports,
  );
  for (const c of d.changes) system.put(c.collection, c.entity);
  const allowed = apply(system, item.id, d.tool);
  for (const c of system.changes) d.put(c.collection, c.entity);
  d.events.push(...system.events);
  d.timeline.push(...system.timeline);
  return allowed;
}

/** Also exercised with synthetic versions while FLOW_VERSION_MAX remains 1. */
export function reconcileFlowReviewLimits(
  d: CommandDraft,
  cardId: WorkItem["card_id"],
) {
  for (const item of d.list("work_items"))
    if (
      item.card_id === cardId &&
      item.kind === "verify" &&
      item.role_id !== "independent_reviewer" &&
      item.status === "waiting_decision"
    )
      applyFlowReviewLimit(d, item);
}
