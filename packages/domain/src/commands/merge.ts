import type { Actor, Card, Decision, Delivery } from "../entities.js";
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
import { reopenMerge } from "./merge-rework.js";

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
/** No Git IO: the caller checks these SHAs against the pinned delivery refs. */
export function mergePlan(state: CommandState, card_id: CardId) {
  return attempt((): MergePlan => {
    const card = state.cards.find(
      (c) => c.id === card_id && c.project_id === state.project_id,
    );
    ensure(card, "not_found", "Card was not found in this project");
    ensure(
      card.status === "awaiting_merge",
      "illegal_transition",
      "Card is not awaiting merge",
    );
    ensure(
      card.repo && card.base_branch && card.merge_policy !== "none",
      "invariant_violation",
      "Git 合并需要仓库、基线和合并策略",
    );
    const target = completion(state, card);
    const deliveries = candidates(state, card);
    ensure(
      deliveries.length > 0,
      "invariant_violation",
      "No accepted Git delivery to merge",
    );
    if ((card.merge_policy ?? "confirm") === "confirm") {
      const q = confirmation(state.decisions, card, target);
      ensure(
        q?.status === "resolved" && q.resolution?.option === "merge",
        "illegal_transition",
        "Merge confirmation has not been granted for this completion",
      );
    }
    ensure(
      !state.decisions.some(
        (q) =>
          q.blocking &&
          ["open", "provisional"].includes(q.status) &&
          (q.card_id === card.id ||
            q.affected_cards.includes(card.id) ||
            q.affected_work_items.some((id) =>
              state.work_items.some(
                (w) => w.id === id && w.card_id === card.id,
              ),
            )),
      ),
      "illegal_transition",
      "Card has an unresolved blocking decision",
    );
    ensure(
      !state.human_actions.some(
        (action) =>
          action.status === "open" &&
          (action.card_id === card.id ||
            action.blocked_work_items.some((id) =>
              state.work_items.some(
                (w) => w.id === id && w.card_id === card.id,
              ),
            )),
      ),
      "illegal_transition",
      "Card has an open human action",
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
function requestConfirmation(d: CommandDraft, card: Card, target: Delivery) {
  const old = confirmation(d.list("decisions"), card, target);
  if (old)
    d.put("decisions", {
      ...old,
      status: unwrap(transition("decision", old.status, "supersede")),
    });
  const id = d.ids.next(d.state.project_id, "decision");
  const q: Decision = {
    id,
    key: id,
    card_id: card.id,
    raised_by: "system",
    trigger: "merge_confirmation",
    kind: "approve",
    target: { delivery_id: target.id },
    category: "general",
    question: `将 ${card.id} 合并到 ${card.base_branch}？`,
    context: target.summary,
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
    blocking: true,
    decider: "human",
    doc_refs: [],
    status: "open",
    ...(old ? { amends: old.id } : {}),
  };
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
    },
    {
      type: "status_change",
      body: `退回修改：${reason}`,
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
  else if ((card.merge_policy ?? "confirm") === "confirm")
    requestConfirmation(d, card, target);
  d.put("cards", next);
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
