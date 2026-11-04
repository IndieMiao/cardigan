import type {
  Card,
  CardId,
  Decision,
  Delivery,
  ProjectId,
  Review,
  WorkItem,
} from "@cardigan/domain";
import type { Identity } from "../auth.js";
import type { McpBackend } from "../backend.js";
import { ToolError } from "../errors.js";

/**
 * Read a card the token is allowed to see.
 *
 * §9.1 scopes a token to "its card and work item": a work-item assignment may
 * only read its own card, while a standing assignment (PM) may read any card of
 * the project. A card outside the scope answers `not_found`, so the endpoint
 * does not leak which cards exist.
 */
export function requireCard(
  store: McpBackend,
  identity: Identity,
  card_id: CardId,
): { readonly card: Card; readonly work_items: readonly WorkItem[] } {
  const project_id = identity.actor.project_id;
  const found = store.uow.read((tx) => {
    const card = tx.cards.get(project_id, card_id);
    if (card === undefined) {
      return undefined;
    }
    return {
      card,
      work_items: tx.work_items
        .list(project_id)
        .filter((item) => item.card_id === card_id),
    };
  });

  if (found === undefined) {
    throw ToolError.notFound(`card ${card_id} not found`);
  }
  if (!inScope(identity, found.work_items)) {
    throw ToolError.notFound(`card ${card_id} not found`);
  }
  return found;
}

function inScope(identity: Identity, work_items: readonly WorkItem[]): boolean {
  const { assignment } = identity;
  if (assignment.scope === "standing") {
    return true;
  }
  return work_items.some((item) => item.id === assignment.work_item_id);
}

export interface CardReadings {
  readonly deliveries: readonly Delivery[];
  readonly reviews: readonly Review[];
  readonly decisions: readonly Decision[];
}

/** Project rows needed to assemble a card view, narrowed to one card. */
export function readCardRelations(
  store: McpBackend,
  project_id: ProjectId,
  card_id: CardId,
  work_items: readonly WorkItem[],
): CardReadings {
  const workItemIds = new Set(work_items.map((item) => item.id));
  return store.uow.read((tx) => {
    const deliveries = tx.deliveries
      .list(project_id)
      .filter((delivery) => workItemIds.has(delivery.work_item_id));
    const deliveryIds = new Set(deliveries.map((delivery) => delivery.id));
    return {
      deliveries,
      reviews: tx.reviews
        .list(project_id)
        .filter(
          (review) =>
            deliveryIds.has(review.delivery_id) ||
            workItemIds.has(review.work_item_id),
        ),
      decisions: tx.decisions
        .list(project_id)
        .filter(
          (decision) =>
            (decision.status === "open" || decision.status === "provisional") &&
            (decision.card_id === card_id ||
              decision.affected_cards.includes(card_id)),
        ),
    };
  });
}
