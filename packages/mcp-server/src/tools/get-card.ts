import type { CardId, CardStatus, Delivery } from "@cardigan/domain";
import {
  deriveCardFields,
  deriveCardStatus,
  deriveReviewMatrix,
} from "@cardigan/domain";
import { z } from "zod";
import { readCardRelations, requireCard } from "./shared.js";
import { defineTool } from "./types.js";

/** Numeric part of a readable ID such as `D-12` or `V-3`. */
function idNumber(id: string): number {
  const digits = /(\d+)\)?$/.exec(id)?.[1];
  return digits === undefined ? 0 : Number(digits);
}

const RECENT_DELIVERY_LIMIT = 10;

/**
 * Card, work items, open decisions, recent deliveries, review matrix and the
 * three derived card fields (§9.2).
 *
 * Everything derived — status, matrix, staleness, `waiting_on`, `next_owners`
 * and `why` — comes from the domain (M1.2 / M1.2b); this tool only gathers the
 * rows and shapes the response.
 */
export const getCardTool = defineTool({
  name: "get_card",
  description:
    "Return a card with its work items, open decisions, recent deliveries, review matrix and derived fields",
  input: z.object({ card_id: z.string().min(1) }),
  handler: ({ card_id }, { store, identity }) => {
    const cardId = card_id as CardId;
    const { card, work_items } = requireCard(store, identity, cardId);
    const { assignments, deliveries, reviews, decisions, human_actions } =
      readCardRelations(store, identity.actor.project_id, cardId, work_items);

    // The newest completion request decides whether the card is waiting for
    // acceptance (invariant 13: derivation never produces `done`).
    const completion = deliveries
      .filter((delivery) => delivery.kind === "card_completion")
      .sort((left, right) => idNumber(right.id) - idNumber(left.id))[0];

    const status: CardStatus = deriveCardStatus(
      card.status,
      work_items,
      completion,
    );

    const derived = deriveCardFields({
      card,
      work_items,
      assignments,
      deliveries,
      reviews,
      decisions,
      human_actions,
      status,
    });

    return {
      card: {
        ...card,
        status,
        stored_status: card.status,
      },
      waiting_on: derived.waiting_on,
      next_owners: derived.next_owners,
      why: derived.why,
      work_items,
      open_decisions: decisions,
      deliveries: [...deliveries]
        .sort((left, right) => idNumber(right.id) - idNumber(left.id))
        .slice(0, RECENT_DELIVERY_LIMIT)
        .map((delivery) => summarizeDelivery(delivery)),
      review_matrix: deriveReviewMatrix(deliveries, work_items, reviews),
      counts: {
        work_items: work_items.length,
        deliveries: deliveries.length,
        reviews: reviews.length,
        open_decisions: decisions.length,
      },
    };
  },
});

function summarizeDelivery(delivery: Delivery): Record<string, unknown> {
  return {
    id: delivery.id,
    work_item_id: delivery.work_item_id,
    run_id: delivery.run_id,
    kind: delivery.kind,
    summary: delivery.summary,
    subject: delivery.subject,
    status: delivery.status,
    branch: delivery.branch ?? null,
    pr_url: delivery.pr_url ?? null,
    supersedes: delivery.supersedes ?? null,
  };
}
