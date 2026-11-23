import type { Card } from "../entities.js";
import type { CardId } from "../ids.js";
import { type CommandState, ensure } from "./core.js";

const newest = <T extends { readonly id: string }>(values: readonly T[]) =>
  [...values].sort(
    (a, b) => Number(b.id.replace(/\D/g, "")) - Number(a.id.replace(/\D/g, "")),
  )[0];
export function acceptedCompletion(
  state: Pick<CommandState, "work_items" | "deliveries">,
  card: Card,
) {
  // Select the card's work items once: O(deliveries + work items) per card.
  const items = new Set<string>();
  for (const w of state.work_items) if (w.card_id === card.id) items.add(w.id);
  const value = newest(
    state.deliveries.filter(
      (v) =>
        v.kind === "card_completion" &&
        v.status !== "superseded" &&
        items.has(v.work_item_id),
    ),
  );
  ensure(
    value?.status === "accepted",
    "invariant_violation",
    "An accepted completion request is required",
  );
  return value;
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
  return { card, target: acceptedCompletion(state, card) };
}
