import { type CardDerivedFields, deriveCardFields } from "../card-derived.js";
import { deriveCardStatus, deriveReviewMatrix } from "../derived.js";
import type { Actor, CardView, Decision } from "../entities.js";
import type { CardId } from "../ids.js";
import { type CommandDraft, type CommandState, command } from "./core.js";

function affects(d: CommandDraft, q: Decision, id: CardId) {
  return (
    q.card_id === id ||
    q.affected_cards.includes(id) ||
    q.affected_work_items.some((wi) => d.get("work_items", wi).card_id === id)
  );
}
type CommandCardView = Omit<CardView, "waiting_on" | "next_owners" | "why"> &
  CardDerivedFields;
function cardView(d: CommandDraft, id: CardId): CommandCardView {
  const card = d.card(id);
  const items = d.list("work_items").filter((w) => w.card_id === id);
  const deliveries = d
    .list("deliveries")
    .filter((v) => items.some((w) => w.id === v.work_item_id));
  const open = d
    .list("decisions")
    .filter(
      (q) =>
        (q.status === "open" || q.status === "provisional") &&
        affects(d, q, id),
    );
  const actions = d
    .list("human_actions")
    .filter(
      (h) =>
        h.status === "open" &&
        (h.card_id === id ||
          h.blocked_work_items.some((wi) => items.some((w) => w.id === wi))),
    );
  const completion = deliveries
    .filter((v) => v.kind === "card_completion" && v.status !== "superseded")
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
  const status = deriveCardStatus(card.status, items, completion);
  const fields = deriveCardFields({
    card,
    work_items: items,
    assignments: d.list("assignments"),
    deliveries,
    reviews: d.list("reviews"),
    decisions: open,
    human_actions: actions,
    status,
  });
  return {
    ...card,
    status,
    open_decisions: open.map((q) => q.id),
    review_matrix: deriveReviewMatrix(deliveries, items, d.list("reviews")),
    ...fields,
  };
}
export function projectSnapshot(state: CommandState, actor: Actor) {
  return command(state, actor, "project_snapshot", undefined, (d) => {
    d.pm();
    d.projectAccess();
    return {
      project_id: state.project_id,
      cards: d.list("cards").map((c) => cardView(d, c.id)),
    };
  });
}
export function listNeedsYou(state: CommandState, actor: Actor) {
  return command(state, actor, "list_needs_you", undefined, (d) => {
    d.pm();
    d.projectAccess();
    const why = (text: string) => [...text].slice(0, 40).join("");
    return {
      decisions: d
        .list("decisions")
        .filter(
          (q) =>
            q.decider === "human" && ["open", "provisional"].includes(q.status),
        )
        .map((q) => ({ ...q, why: why(q.question) })),
      human_actions: d
        .list("human_actions")
        .filter((h) => h.status === "open")
        .map((h) => ({ ...h, why: why(h.why_human) })),
    };
  });
}
