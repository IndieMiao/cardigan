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
      ensure(
        delivery || !w.required,
        "invariant_violation",
        `Missing current delivery for ${w.id}`,
      );
      if (delivery?.kind !== "code" || delivery.subject.kind !== "git_head")
        return [];
      ensure(
        delivery.status === "accepted" && w.status === "accepted",
        "invariant_violation",
        `Code delivery for ${w.id} is not accepted`,
      );
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
    const target = completion(state, card);
    const deliveries = candidates(state, card);
    ensure(
      deliveries.length > 0,
      "invariant_violation",
      "No accepted Git code delivery to merge",
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
    question: `Merge ${card.id} into ${card.base_branch}?`,
    context: target.summary,
    options: [
      {
        key: "merge",
        description: "Merge accepted deliveries",
        impact: "Advance the central baseline",
      },
      {
        key: "hold",
        description: "Hold this merge",
        impact: "Keep the card awaiting merge",
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
