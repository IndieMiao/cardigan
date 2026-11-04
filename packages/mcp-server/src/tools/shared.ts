import type { Card, CardId, ProjectId } from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { ToolError } from "../errors.js";

/** Read a card or refuse with `not_found`. */
export function requireCard(
  store: Store,
  project_id: ProjectId,
  card_id: CardId,
): Card {
  const card = store.uow.run((tx) => tx.cards.get(project_id, card_id));
  if (card === undefined) {
    throw ToolError.notFound(`card ${card_id} not found`);
  }
  return card;
}
