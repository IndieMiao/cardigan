import type {
  Assignment,
  Card,
  CardId,
  Decision,
  Delivery,
  HumanAction,
  ProjectId,
  Review,
  WorkItem,
} from "@cardigan/domain";
import type { Identity } from "../auth.js";
import type { McpBackend } from "../backend.js";
import { ToolError } from "../errors.js";

/**
 * Stream key of the project-level event stream.
 *
 * The store keys event streams by card id, with `""` for "no card"; `get_updates`
 * and `ack_events` both fall back to it when the caller omits `card_id` (S5).
 * Declared here as a literal so `mcp-server` keeps depending on `domain` only
 * (§20.2); `get-updates-cursor.test.ts` exercises it against a real store.
 */
export const PROJECT_STREAM = "";

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

/**
 * The card as an Agent may see it: host paths stay on the host (§9.2, M5.S S13).
 * An Agent finds its own checkout through `whoami().worktree_path`, never by
 * reading the project's registered repository from the card.
 */
export function agentCard<T extends { readonly repo?: string }>(
  card: T,
): Omit<T, "repo"> {
  const { repo: _hostPath, ...rest } = card;
  return rest;
}

export interface CardReadings {
  readonly assignments: readonly Assignment[];
  readonly deliveries: readonly Delivery[];
  readonly reviews: readonly Review[];
  readonly decisions: readonly Decision[];
  readonly human_actions: readonly HumanAction[];
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
      assignments: tx.assignments
        .list(project_id)
        .filter(
          (assignment) =>
            assignment.scope === "work_item" &&
            workItemIds.has(assignment.work_item_id),
        ),
      human_actions: tx.human_actions
        .list(project_id)
        .filter(
          (action) =>
            action.status === "open" &&
            (action.card_id === card_id ||
              action.blocked_work_items.some((id) => workItemIds.has(id))),
        ),
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
