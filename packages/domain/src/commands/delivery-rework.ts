import { reviewPassed } from "../derived.js";
import type { Actor, Decision } from "../entities.js";
import { appendEvents } from "../event-index.js";
import type { DeliveryId, ReviewId, WorkItemId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  type CommandDraft,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  text,
  unwrap,
} from "./core.js";
import { isPmOps } from "./delegation.js";
import {
  supersedeDelivery,
  supersedeReworkRequest,
} from "./delivery-invalidation.js";
import { personallyResolved } from "./human-decided-merge.js";
import { returnedHumanConfirmation } from "./merge.js";
import { latestMergeCheck } from "./merge-check.js";
import { reopenMerge, supersedeCompletion } from "./merge-rework.js";

export interface DeliveryReworkParams {
  readonly work_item_id: WorkItemId;
  readonly delivery_id: DeliveryId;
  readonly target_sha: string;
  readonly review_id: ReviewId;
  readonly rationale: string;
}

/** Only the exact product and the withdrawn approval authorize this return. */
function basis(p: Omit<DeliveryReworkParams, "rationale">): string {
  return JSON.stringify([
    p.work_item_id,
    p.delivery_id,
    p.target_sha,
    p.review_id,
  ]);
}

function humanScopeAuthority(
  d: CommandDraft,
  card: import("../entities.js").Card,
) {
  if (card.sensitive || card.source.kind !== "decision") return false;
  const sourceId = card.source.decision_id;
  const source = d.list("decisions").find((q) => q.id === sourceId);
  return (
    source?.category === "scope_change" &&
    personallyResolved(source) &&
    appendEvents(d.state.events, d.events).some(
      (e) =>
        e.type === "decision_resolved" &&
        e.actor.kind === "human" &&
        e.actor.project_id === d.state.project_id &&
        (e.payload as { decision_id?: string; option?: string }).decision_id ===
          source.id &&
        (e.payload as { option?: string }).option === source.resolution?.option,
    )
  );
}

function reworkTarget(
  d: CommandDraft,
  p: Omit<DeliveryReworkParams, "rationale">,
) {
  const item = d.work(p.work_item_id);
  const card = d.card(item.card_id);
  const delivery = d.get("deliveries", p.delivery_id);
  ensure(
    ["in_progress", "review", "awaiting_merge"].includes(card.status),
    "illegal_transition",
    "卡片已关闭或尚未进入执行阶段",
  );
  ensure(
    item.kind === "produce" &&
      item.status === "accepted" &&
      delivery.work_item_id === item.id &&
      delivery.kind !== "card_completion" &&
      delivery.status === "accepted",
    "stale_target",
    "只能退回当前已接受的产出",
  );
  ensure(
    delivery.subject.kind === "git_head" &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(p.target_sha) &&
      delivery.subject.value === p.target_sha,
    "stale_target",
    "返工须绑定完整的当前提交",
  );
  const products = d
    .list("deliveries")
    .filter((v) => v.work_item_id === item.id && v.kind !== "card_completion");
  ensure(
    [...products]
      .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
      .at(-1)?.id === delivery.id &&
      !products.some((v) => v.supersedes === delivery.id),
    "stale_target",
    "交付已被新版本取代",
  );
  const review = d.get("reviews", p.review_id);
  const verifier = d.work(review.work_item_id);
  const run = d.get("runs", review.run_id);
  const withdrawal = d.state.events.find(
    (e) =>
      e.card_id === card.id &&
      e.type === "review_withdrawn" &&
      (e.payload as { review_id?: string; work_item_id?: string }).review_id ===
        review.id &&
      (e.payload as { work_item_id?: string }).work_item_id === verifier.id &&
      e.actor.kind === "assignment" &&
      e.actor.assignment_id === run.assignment_id,
  );
  ensure(
    review.delivery_id === delivery.id &&
      review.target_sha === p.target_sha &&
      reviewPassed(review) &&
      review.withdrawn &&
      withdrawal &&
      (withdrawal.payload as { rationale?: string }).rationale ===
        review.withdrawn.rationale &&
      verifier.assignment_id === run.assignment_id &&
      verifier.kind === "verify" &&
      verifier.card_id === card.id &&
      verifier.target_work_item_id === item.id &&
      verifier.status !== "cancelled" &&
      !verifier.replaced_by_work_item_id &&
      delivery.requested_verifiers.includes(verifier.id) &&
      d
        .list("reviews")
        .filter((r) => r.work_item_id === verifier.id)
        .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
        .at(-1)?.id === review.id,
    "stale_target",
    "须绑定当前审核员本人正式撤回的最新审核",
  );
  ensure(
    !d.state.events.some(
      (e) => e.card_id === card.id && e.type === "card_merged",
    ),
    "illegal_transition",
    "卡片已经发布",
  );
  const completions = d
    .list("deliveries")
    .filter(
      (v) =>
        v.kind === "card_completion" &&
        v.status !== "superseded" &&
        d.work(v.work_item_id).card_id === card.id,
    );
  ensure(
    !completions.some(
      (v) =>
        latestMergeCheck(d.state.events, card.id, v.id)?.status === "running",
    ),
    "illegal_transition",
    "合并检查正在运行，暂不能返工",
  );
  return { item, card, delivery, review, withdrawal, completions };
}

/** Q-659: Ops may request; only a real human resolution can perform the return. */
export function requestDeliveryRework(
  state: CommandState,
  actor: Actor,
  p: DeliveryReworkParams,
  ports: CommandPorts,
) {
  return command(state, actor, "request_delivery_rework", ports, (d) => {
    ensure(
      actor.kind === "human" || isPmOps(d),
      "forbidden_tool",
      "只有后台 PM 或人可以请求正式返工",
    );
    text(p.rationale, "rationale");
    const { item, card, delivery, withdrawal } = reworkTarget(d, p);
    const requirements = basis(p);
    const prior = d
      .list("decisions")
      .find(
        (q) =>
          q.trigger === "accepted_delivery_rework" &&
          q.card_id === card.id &&
          q.rework_target?.delivery_id === delivery.id &&
          q.rework_target.review_id === p.review_id &&
          q.status === "open",
      );
    if (prior && !(isPmOps(d) && humanScopeAuthority(d, card))) return prior;
    for (const old of d.list("decisions")) {
      if (
        old.trigger === "accepted_delivery_rework" &&
        old.rework_target?.work_item_id === item.id &&
        ["open", "snoozed"].includes(old.status)
      )
        supersedeReworkRequest(d, card, old.id);
    }
    const id = d.ids.next(state.project_id, "decision");
    const decision: Decision = {
      id,
      key: id,
      card_id: card.id,
      raised_by: d.author,
      kind: "approve",
      trigger: "accepted_delivery_rework",
      category: "feature_detail",
      target: { delivery_id: delivery.id },
      rework_target: {
        work_item_id: item.id,
        delivery_id: delivery.id,
        target_sha: p.target_sha,
        review_id: p.review_id,
        withdrawal_event_id: withdrawal.id,
        basis: requirements,
      },
      question: `将 ${card.id} 的 ${item.title} 正式退回作者修改？`,
      context: `${p.rationale}\n\n当前交付：${delivery.id}\n完整提交：${p.target_sha}\n本人撤回的审核：${p.review_id}\n批准后作废该交付及完成申请，通知原作者返工，重新交付和审核。`,
      plain_summary: {
        changed: "把已验收的产出正式退回作者修改，保留原审核和撤回理由。",
        impact: "旧交付和完成申请作废，作者收到返工通知，新版本重新审核。",
        risk: "本次只授权退回当前产出，不放宽权限、不删除数据。",
      },
      options: [
        {
          key: "return_for_rework",
          description: "正式退回作者修改",
          impact: "作废旧交付和完成申请，重新交付并审核",
        },
        { key: "keep", description: "保留当前产出", impact: "不执行本次返工" },
      ],
      recommended: "return_for_rework",
      affected_cards: [card.id],
      affected_work_items: [],
      blocking: true,
      decider: humanScopeAuthority(d, card) && isPmOps(d) ? "role:pm" : "human",
      ...(humanScopeAuthority(d, card) && isPmOps(d)
        ? {}
        : {
            human_required_reason:
              "已验收产出返工缺少人亲自拍板的来源范围，须由人确认。",
          }),
      doc_refs: [],
      status: "open",
    };
    d.put("decisions", decision);
    d.emit(
      "decision_requested",
      card.id,
      { decision_id: id, affected_work_items: [] },
      { type: "decision_request", decision_id: id, body: decision.question },
    );
    if (decision.decider === "role:pm") {
      const notice = `${card.id} 按人已拍板的来源范围返工：${p.rationale}；人可停止或撤销后续工作。`;
      const resolved: Decision = {
        ...decision,
        status: "resolved",
        resolution: {
          option: "return_for_rework",
          rationale: p.rationale,
          raw_quote: "",
          resolved_by: d.author,
          via: "delegated",
          via_chain: [d.author],
          proxy_authority: `human-scope:${card.source.kind === "decision" ? card.source.decision_id : ""}`,
          notice,
          at: d.now,
        },
      };
      resolveDeliveryRework(d, resolved, "return_for_rework");
      d.put("decisions", resolved);
      d.emit(
        "decision_resolved",
        card.id,
        {
          decision_id: id,
          option: "return_for_rework",
          via: "delegated",
          notice: notice,
        },
        {
          type: "decision_resolved",
          decision_id: id,
          body: notice,
        },
      );
      return resolved;
    }
    return decision;
  });
}

/** Called within the same transaction that records the human's answer. */
export function resolveDeliveryRework(
  d: CommandDraft,
  q: Decision,
  option: string,
): void {
  ensure(
    ((d.actor.kind === "human" && q.decider === "human") ||
      (isPmOps(d) &&
        q.decider === "role:pm" &&
        !!q.card_id &&
        humanScopeAuthority(d, d.card(q.card_id)))) &&
      q.rework_target &&
      q.card_id,
    "forbidden_tool",
    "正式返工只能由人亲自确认",
  );
  if (option === "keep") return;
  ensure(option === "return_for_rework", "validation_failed", "无效返工选项");
  const target = q.rework_target;
  ensure(
    q.kind === "approve" &&
      "delivery_id" in q.target &&
      q.target.delivery_id === target.delivery_id,
    "stale_target",
    "返工决定目标不符",
  );
  const { item, card, delivery, review, withdrawal, completions } =
    reworkTarget(d, target);
  ensure(
    card.id === q.card_id && withdrawal.id === target.withdrawal_event_id,
    "stale_target",
    "返工依据已经变化，请重新请求",
  );
  const confirmations = d
    .list("decisions")
    .filter(
      (v) =>
        v.card_id === card.id &&
        (v.trigger === "merge_confirmation" ||
          v.trigger === "completion_review") &&
        v.kind === "approve" &&
        "delivery_id" in v.target &&
        completions.some(
          (c) => "delivery_id" in v.target && c.id === v.target.delivery_id,
        ),
    );
  const inherited =
    confirmations.find(
      (v) => v.trigger === "merge_confirmation" && v.human_required_reason,
    ) ?? returnedHumanConfirmation(d, card);
  const previousCompletion =
    inherited?.kind === "approve" && "delivery_id" in inherited.target
      ? inherited.target.delivery_id
      : undefined;
  if (card.status === "awaiting_merge" && completions[0]) {
    reopenMerge(d, card, completions[0], item.id, "request_changes");
  } else {
    d.put("work_items", d.move(item, "request_changes"));
    d.put("cards", {
      ...card,
      status:
        card.status === "review"
          ? unwrap(
              transition("card", card.status, "completion_review_rejected"),
            )
          : card.status,
    });
  }
  for (const completion of completions)
    if (d.get("deliveries", completion.id).status !== "superseded")
      supersedeCompletion(d, card, completion);
  supersedeDelivery(d, card, delivery);
  for (const w of d.list("work_items")) {
    if (
      w.kind !== "verify" ||
      w.card_id !== card.id ||
      w.replaced_by_work_item_id
    )
      continue;
    const affected =
      w.target_work_item_id === item.id ||
      (!w.target_work_item_id && completions.length > 0);
    if (
      affected &&
      ["ready", "in_progress", "passed", "failed"].includes(w.status)
    )
      d.put("work_items", d.move(w, "target_withdrawn"));
  }
  for (const old of confirmations) {
    if (!["open", "snoozed", "provisional", "resolved"].includes(old.status))
      continue;
    if (d.get("decisions", old.id).status === "superseded") continue;
    d.put("decisions", {
      ...old,
      status: unwrap(
        transition(
          "decision",
          old.status,
          old.status === "provisional" ? "revoke" : "supersede",
        ),
      ),
    });
  }
  d.emit(
    "merge_changes_requested",
    card.id,
    {
      decision_id: q.id,
      work_item_id: item.id,
      delivery_id: delivery.id,
      target_sha: target.target_sha,
      review_id: review.id,
      withdrawal_event_id: withdrawal.id,
      ...(completions[0] ? { completion_id: completions[0].id } : {}),
      completion_ids: completions.map((c) => c.id),
      ...(inherited && previousCompletion
        ? {
            previous_confirmation_id: inherited.id,
            previous_completion_id: previousCompletion,
          }
        : {}),
      run_kind: "fix",
      reason: q.context,
      via:
        d.actor.kind === "human"
          ? "human_delivery_rework"
          : "delegated_delivery_rework",
    },
    {
      type: "status_change",
      work_item_id: item.id,
      decision_id: q.id,
      body: `人已确认，正式退回作者修改：${q.context}`,
      refs: [
        { kind: "review", id: review.id },
        { kind: "decision", id: q.id },
      ],
    },
  );
}
