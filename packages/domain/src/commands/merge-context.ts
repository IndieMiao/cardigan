import type { Card } from "../entities.js";
import type { CardId } from "../ids.js";
import { type CommandState, ensure } from "./core.js";

const idNumber = (id: string) => Number(id.replace(/\D/g, ""));

/**
 * C-631: the value with the largest numeric id, first one on ties — the same
 * pick as a stable descending sort, without copying and sorting the input.
 */
export function newestById<T extends { readonly id: string }>(
  values: Iterable<T>,
): T | undefined {
  let best: T | undefined;
  let bestN = 0;
  for (const v of values) {
    const n = idNumber(v.id);
    if (best === undefined || n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

/** C-631: one pass over work items, then one pass over deliveries. */
export function acceptedCompletion(
  state: Pick<CommandState, "work_items" | "deliveries">,
  card: Card,
) {
  const ids = new Set<string>();
  for (const w of state.work_items) if (w.card_id === card.id) ids.add(w.id);
  const value = newestById(
    state.deliveries.filter(
      (v) =>
        v.kind === "card_completion" &&
        v.status !== "superseded" &&
        ids.has(v.work_item_id),
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
