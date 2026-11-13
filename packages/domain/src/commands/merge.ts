import type {
  Actor,
  Card,
  Decision,
  Delivery,
  HumanAction,
} from "../entities.js";
import type { Result } from "../errors.js";
import type { CardId } from "../ids.js";
import { transition } from "../transitions.js";
import {
  attempt,
  type CommandDraft,
  type CommandEffect,
  type CommandPorts,
  type CommandState,
  command,
  ensure,
  unwrap,
} from "./core.js";
import { MAX_DECISION_ATTACHMENTS } from "./decision-attachments.js";
import {
  assignDecision,
  handoffDecision,
  mergeNeedsHuman,
  riskTagAutoMergeAllowed,
} from "./delegation.js";
import { reopenMerge } from "./merge-rework.js";
import { screenshotCheckBlocker } from "./screenshot-check.js";

const newest = <T extends { readonly id: string }>(values: readonly T[]) =>
  [...values].sort(
    (a, b) => Number(b.id.replace(/\D/g, "")) - Number(a.id.replace(/\D/g, "")),
  )[0];
export interface MergePlan {
  readonly card_id: CardId;
  readonly title: string;
  readonly base_branch: string;
  readonly completion_id: Delivery["id"];
  readonly deliveries: readonly {
    readonly delivery_id: Delivery["id"];
    readonly work_item_id: Delivery["work_item_id"];
    readonly sha: string;
  }[];
}
function candidates(
  state: Pick<CommandState, "work_items" | "deliveries">,
  card: Card,
) {
  return state.work_items
    .filter((w) => w.card_id === card.id && w.kind === "produce")
    .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)))
    .flatMap((w) => {
      const delivery = newest(
        state.deliveries.filter(
          (v) =>
            v.work_item_id === w.id &&
            v.kind !== "card_completion" &&
            v.status !== "superseded",
        ),
      );
      if (
        delivery?.status !== "accepted" ||
        delivery.subject.kind !== "git_head"
      )
        return [];
      return [
        {
          delivery_id: delivery.id,
          work_item_id: w.id,
          sha: delivery.subject.value,
        },
      ];
    });
}
function completion(
  state: Pick<CommandState, "work_items" | "deliveries">,
  card: Card,
) {
  const value = newest(
    state.deliveries.filter(
      (v) =>
        v.kind === "card_completion" &&
        v.status !== "superseded" &&
        state.work_items.some(
          (w) => w.card_id === card.id && w.id === v.work_item_id,
        ),
    ),
  );
  ensure(
    value?.status === "accepted",
    "invariant_violation",
    "An accepted completion request is required",
  );
  return value;
}
/** C-65: a sensitive card needs a confirmation whatever its template says. */
function confirmsMerge(card: Card) {
  return !!card.sensitive || (card.merge_policy ?? "confirm") === "confirm";
}
/** The human answered personally in Workbench or the local CLI. */
function answeredByHuman(q: Decision) {
  return (
    q.resolution?.resolved_by === "human" && q.resolution.via === "needs_you"
  );
}
function confirmation(
  decisions: readonly Decision[],
  card: Card,
  target: Delivery,
) {
  return newest(
    decisions.filter(
      (q) =>
        q.trigger === "merge_confirmation" &&
        q.card_id === card.id &&
        q.kind === "approve" &&
        "delivery_id" in q.target &&
        q.target.delivery_id === target.id,
    ),
  );
}
/**
 * C-112: open human actions that hold this card's merge. Only actions that
 * block one of the card's work items, or were explicitly raised with
 * `blocks_merge`, count; read-only escalations (logs, diagnostics) that merely
 * name the card do not.
 */
export function mergeBlockingHumanActions(
  state: Pick<CommandState, "human_actions" | "work_items">,
  card_id: CardId,
): HumanAction[] {
  return state.human_actions.filter(
    (action) =>
      action.status === "open" &&
      ((action.blocks_merge === true && action.card_id === card_id) ||
        action.blocked_work_items.some((id) =>
          state.work_items.some((w) => w.id === id && w.card_id === card_id),
        )),
  );
}
/** No Git IO: the caller checks these SHAs against the pinned delivery refs. */
export function mergePlan(state: CommandState, card_id: CardId) {
  return planFor(state, card_id, true);
}
/** Candidate preparation may precede confirmation; publication still uses mergePlan. */
export function prepareMergePlan(state: CommandState, card_id: CardId) {
  return planFor(state, card_id, false);
}
/** Shared with the observation path; confirmation only gates publication. */
export function mergeBlockingDecisions(
  state: CommandState,
  card_id: CardId,
  completion_id: Delivery["id"],
  confirmed: boolean,
) {
  return state.decisions.filter(
    (q) =>
      !(
        !confirmed &&
        q.trigger === "merge_confirmation" &&
        q.kind === "approve" &&
        "delivery_id" in q.target &&
        q.target.delivery_id === completion_id
      ) &&
      q.blocking &&
      ["open", "provisional", "snoozed"].includes(q.status) &&
      (q.card_id === card_id ||
        q.affected_cards.includes(card_id) ||
        q.affected_work_items.some((id) =>
          state.work_items.some((w) => w.id === id && w.card_id === card_id),
        )),
  );
}
/** Recording a running check must survive unrelated decisions opened after it started. */
export function mergeContext(state: CommandState, card_id: CardId) {
  const card = state.cards.find(
    (c) => c.id === card_id && c.project_id === state.project_id,
  );
  ensure(card, "not_found", "Card was not found in this project");
  ensure(
    card.status === "awaiting_merge",
    "illegal_transition",
    "Card is not awaiting merge",
  );
  return { card, target: completion(state, card) };
}
function planFor(state: CommandState, card_id: CardId, confirmed: boolean) {
  return attempt((): MergePlan => {
    const { card, target } = mergeContext(state, card_id);
    ensure(
      card.repo && card.base_branch && card.merge_policy !== "none",
      "invariant_violation",
      "Git 合并需要仓库、基线和合并策略",
    );
    const deliveries = candidates(state, card);
    ensure(
      deliveries.length > 0,
      "invariant_violation",
      "No accepted Git delivery to merge",
    );
    if (confirmed && confirmsMerge(card)) {
      const q = confirmation(state.decisions, card, target);
      ensure(
        q?.status === "resolved" && q.resolution?.option === "merge",
        "illegal_transition",
        "Merge confirmation has not been granted for this completion",
      );
      // C-65: checked again at publication, so an earlier PM, Office or
      // timeout answer cannot outlive a flag set before the merge lands.
      ensure(
        !card.sensitive || answeredByHuman(q),
        "illegal_transition",
        "敏感卡片的合并须由人亲自确认",
      );
      ensure(
        !card.risk_tags?.length ||
          answeredByHuman(q) ||
          riskTagAutoMergeAllowed(state, q),
        "illegal_transition",
        "风险标签卡已不满足独立复核条件，旧代理确认不能用于合并，须由人重新确认",
      );
      // Q-336 (a): re-checked at publication, so a PM or timeout answer
      // cannot outlive a screenshot projection reset or redelivery.
      const screenshot = answeredByHuman(q)
        ? undefined
        : screenshotCheckBlocker(state, card);
      ensure(
        !screenshot,
        "illegal_transition",
        `${screenshot}，旧代理确认不能用于合并`,
      );
    }
    const decision = mergeBlockingDecisions(
      state,
      card.id,
      target.id,
      confirmed,
    )[0];
    // C-112: the message names the blocker so `merge status` and the loops'
    // skip logs can say which item holds the merge.
    ensure(
      !decision,
      "illegal_transition",
      `合并被未解决的阻塞拍板 ${decision?.id} 挡住`,
      { merge_blocker: true, completion_id: target.id },
    );
    const action = mergeBlockingHumanActions(state, card.id)[0];
    ensure(
      !action,
      "illegal_transition",
      `合并被待执行的人工事项 ${action?.id} 挡住`,
      { merge_blocker: true, completion_id: target.id },
    );
    return {
      card_id,
      title: card.title,
      base_branch: card.base_branch,
      completion_id: target.id,
      deliveries,
    };
  });
}
/**
 * C-95: the human sees the completion request's own card attachments
 * (screenshots, designs) on the merge confirmation, up to the shared limit.
 */
function completionAttachments(d: CommandDraft, card: Card, target: Delivery) {
  const own = new Set(
    d
      .list("attachments")
      .filter((a) => a.card_id === card.id)
      .map((a) => a.id),
  );
  const attachment_ids = [...new Set(target.attachments)]
    .filter((id) => own.has(id))
    .slice(0, MAX_DECISION_ATTACHMENTS);
  return attachment_ids.length ? { attachment_ids } : {};
}
function requestConfirmation(d: CommandDraft, card: Card, target: Delivery) {
  const old = confirmation(d.list("decisions"), card, target);
  if (old)
    d.put("decisions", {
      ...old,
      status: unwrap(transition("decision", old.status, "supersede")),
    });
  const id = d.ids.next(d.state.project_id, "decision");
  const sensitive = mergeNeedsHuman(
    d.list("decisions"),
    d.list("cards"),
    card.id,
  );
  const draft: Decision = {
    id,
    key: id,
    card_id: card.id,
    raised_by: "system",
    trigger: "merge_confirmation",
    kind: "approve",
    target: { delivery_id: target.id },
    category: "general",
    question: `将 ${card.id} 合并到 ${card.base_branch}？`,
    context: sensitive ? `${target.summary}\n\n${sensitive}` : target.summary,
    options: [
      {
        key: "merge",
        description: "合并已通过验收的交付",
        impact: "更新中心仓库的基线分支",
      },
      {
        key: "hold",
        description: "暂缓合并",
        impact: "卡片继续等待合并",
      },
      {
        key: "request_changes",
        description: "退回修改",
        impact: "退回产出方修改，重新交付并审核",
      },
    ],
    recommended: "merge",
    affected_cards: [card.id],
    affected_work_items: [],
    ...completionAttachments(d, card, target),
    blocking: true,
    decider: "human",
    doc_refs: [],
    status: "open",
    ...(old ? { amends: old.id } : {}),
  };
  // §7.4: PM Ops confirms by default; D12, scope changes and the opt-out stay human.
  const q = assignDecision(d, draft);
  d.put("decisions", q);
  d.emit(
    "decision_requested",
    card.id,
    { decision_id: id, affected_work_items: [] },
    { type: "decision_request", decision_id: id, body: q.question },
  );
  return q;
}
export function requestMergeChanges(
  d: CommandDraft,
  decision: Decision,
  reason: string,
  raw_quote: string,
  /** PM Ops returning after a failed check (§7.4): notice for Needs You. */
  delegated?: { readonly notice: string; readonly proxy_authority: string },
  /** C-192: the human returned with one click on the suggestion. */
  viaSuggestion = false,
) {
  ensure(
    decision.card_id &&
      decision.kind === "approve" &&
      "delivery_id" in decision.target,
    "invariant_violation",
    "Merge confirmation must target a completion request",
  );
  const card = d.card(decision.card_id);
  const target = completion(
    { work_items: d.list("work_items"), deliveries: d.list("deliveries") },
    card,
  );
  ensure(
    target.id === decision.target.delivery_id &&
      confirmation(d.list("decisions"), card, target)?.id === decision.id,
    "stale_target",
    "Merge confirmation belongs to an older completion request",
  );
  reopenMerge(d, card, target, target.work_item_id, "request_changes");
  d.emit(
    "merge_changes_requested",
    card.id,
    {
      decision_id: decision.id,
      completion_id: target.id,
      work_item_id: target.work_item_id,
      run_kind: "fix",
      reason,
      raw_quote,
      ...(delegated
        ? {
            via: "delegated",
            notice: delegated.notice,
            proxy_authority: delegated.proxy_authority,
          }
        : {}),
      ...(viaSuggestion ? { via_suggestion: true } : {}),
    },
    {
      type: "status_change",
      body: `${viaSuggestion ? "按建议处理，退回修改" : "退回修改"}：${reason}`,
      decision_id: decision.id,
      work_item_id: target.work_item_id,
    },
  );
}
export function completionPassed(
  d: CommandDraft,
  card: Card,
  target: Delivery,
) {
  let next = {
    ...card,
    status: unwrap(transition("card", card.status, "completion_review_passed")),
  };
  if (
    candidates(
      { work_items: d.list("work_items"), deliveries: d.list("deliveries") },
      card,
    ).length === 0
  )
    next = {
      ...next,
      status: unwrap(transition("card", next.status, "merge_not_required")),
      resolution: "done",
    };
  else if (confirmsMerge(card)) requestConfirmation(d, card, target);
  d.put("cards", next);
}
/**
 * C-65: after the sensitive flag changes on a card awaiting merge, make the
 * current completion's confirmation match it. Marking supersedes a merge not
 * answered by the human personally (PM Ops, Office, timeout; the record is
 * kept) and asks the human again; an auto-policy card gets its first
 * confirmation. Unmarking an auto-policy card withdraws the unanswered one,
 * so the template's auto merge applies again. PM-held open confirmations are
 * handed over by the caller.
 */
export function syncSensitiveMerge(d: CommandDraft, card: Card) {
  if (card.status !== "awaiting_merge" || card.merge_policy === "none") return;
  const state = {
    work_items: d.list("work_items"),
    deliveries: d.list("deliveries"),
  };
  const target = attempt(() => completion(state, card));
  if (!target.ok || candidates(state, card).length === 0) return;
  const q = confirmation(d.list("decisions"), card, target.value);
  if (q && !["open", "provisional", "snoozed", "resolved"].includes(q.status))
    return;
  if (card.sensitive) {
    if (
      !q ||
      (q.status === "resolved" &&
        q.resolution?.option === "merge" &&
        !answeredByHuman(q))
    )
      requestConfirmation(d, card, target.value);
    return;
  }
  if (q && ["open", "snoozed"].includes(q.status) && !confirmsMerge(card)) {
    d.put("decisions", {
      ...q,
      status: unwrap(transition("decision", q.status, "supersede")),
    });
    d.emit(
      "decision_superseded",
      card.id,
      { decision_id: q.id, reason: "card_not_sensitive" },
      {
        type: "status_change",
        decision_id: q.id,
        body: `${q.id} 已作废：卡片不再敏感，按模板自动合并。`,
      },
    );
  }
}

/** Recheck pending/unpublished delegated confirmations after eligibility changes. */
export function syncRiskTagMerge(d: CommandDraft, card: Card) {
  if (card.status !== "awaiting_merge" || !card.risk_tags?.length) return;
  const state = {
    cards: d.list("cards"),
    decisions: d.list("decisions"),
    work_items: d.list("work_items"),
    deliveries: d.list("deliveries"),
    reviews: d.list("reviews"),
  };
  const target = attempt(() => completion(state, card));
  if (!target.ok) return;
  const q = confirmation(state.decisions, card, target.value);
  if (!q || riskTagAutoMergeAllowed(state, q)) return;
  const reason =
    "风险标签或独立复核资格已变化，当前不满足代确认条件，合并转交给人确认。";
  if (
    q.decider === "role:pm" &&
    ["open", "provisional", "snoozed"].includes(q.status)
  ) {
    handoffDecision(d, q, reason);
  } else if (
    q.status === "resolved" &&
    q.resolution?.option === "merge" &&
    !answeredByHuman(q)
  ) {
    // Keep the old resolution/authority as history; never resurrect it when
    // eligibility returns. The new confirmation has its own decision ID.
    const next = requestConfirmation(d, card, target.value);
    d.put("decisions", { ...next, context: `${next.context}\n\n${reason}` });
    d.emit(
      "decision_superseded",
      card.id,
      {
        decision_id: q.id,
        reason: "risk_tag_merge_ineligible",
        replacement_decision_id: next.id,
      },
      {
        type: "status_change",
        decision_id: q.id,
        body: `${q.id} 的旧代理合并确认已作废：${reason}`,
      },
    );
  }
}
/**
 * Q-336 (a): when the screenshot check stops qualifying (reset, withdrawn,
 * switch turned on after a delegated answer), an unpublished non-human merge
 * authorization is superseded and a new confirmation goes to the human, who
 * may merge or return it. The old resolution stays as history and is never
 * resurrected; human answers and open PM-held confirmations are untouched
 * (the latter stay blocked by pmMergeBlockers).
 */
export function syncScreenshotMerge(d: CommandDraft, card: Card) {
  if (card.status !== "awaiting_merge") return;
  const blocker = screenshotCheckBlocker(
    {
      project_id: d.state.project_id,
      project_preferences: d.list("project_preferences"),
      assignments: d.list("assignments"),
      work_items: d.list("work_items"),
      deliveries: d.list("deliveries"),
    },
    card,
  );
  if (!blocker) return;
  const decisions = d.list("decisions");
  const target = attempt(() =>
    completion(
      { work_items: d.list("work_items"), deliveries: d.list("deliveries") },
      card,
    ),
  );
  if (!target.ok) return;
  const q = confirmation(decisions, card, target.value);
  if (
    q?.status !== "resolved" ||
    q.resolution?.option !== "merge" ||
    answeredByHuman(q)
  )
    return;
  const reason = `截图核对资格已变化（${blocker}），旧代理合并确认作废，合并转交给人确认。`;
  const next = requestConfirmation(d, card, target.value);
  d.put("decisions", {
    ...next,
    decider: "human",
    context: `${next.context}\n\n${reason}`,
    human_required_reason: reason,
  });
  d.emit(
    "decision_superseded",
    card.id,
    {
      decision_id: q.id,
      reason: "screenshot_check_ineligible",
      replacement_decision_id: next.id,
    },
    {
      type: "status_change",
      decision_id: q.id,
      body: `${q.id} 的旧代理合并确认已作废：${reason}`,
    },
  );
}
export function requestMerge(
  state: CommandState,
  actor: Actor,
  p: { card_id: CardId },
  ports: CommandPorts,
): Result<CommandEffect<Decision>> {
  return command(state, actor, "request_merge", ports, (d) => {
    ensure(
      actor.kind === "human" ||
        (d.assignment?.scope === "standing" &&
          actor.kind === "assignment" &&
          actor.role_id === "pm" &&
          !actor.allowed_tools.includes("record_decision")),
      "unauthorized",
      "Only the human or PM Ops can request a merge",
    );
    const card = d.card(p.card_id);
    ensure(
      card.status === "awaiting_merge",
      "illegal_transition",
      "Card is not awaiting merge",
    );
    const target = completion(state, card);
    const q = confirmation(state.decisions, card, target);
    ensure(
      q?.status === "resolved" && q.resolution?.option === "hold",
      "illegal_transition",
      "Only a held merge can be requested again",
    );
    return requestConfirmation(d, card, target);
  });
}
