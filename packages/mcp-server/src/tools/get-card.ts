import type { CardId, CardStatus, CardView, Delivery } from "@cardigan/domain";
import {
  cardTemplate,
  decisionAuthorView,
  deriveCardFields,
  deriveCardStatus,
  deriveReviewMatrix,
  latestMergeCheck,
  mergeClassificationView,
  mergeShadowComparisons,
  roleRuleDeliveries,
  roleRuleInventory,
  runAuthorView,
} from "@cardigan/domain";
import { z } from "zod";
import { agentCard, readCardRelations, requireCard } from "./shared.js";
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

    const authors = store.uow.read((tx) => ({
      assignments,
      templates: tx.card_templates?.list(identity.actor.project_id) ?? [],
      runs: tx.runs.list(identity.actor.project_id),
      employees: tx.employees?.list() ?? [],
      members: tx.members?.list() ?? [],
    }));

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

    const mergeCheck =
      completion && completion.status !== "superseded"
        ? store.uow.read((tx) =>
            latestMergeCheck(
              tx.events.listAfter(identity.actor.project_id, cardId, 0),
              cardId,
              completion.id,
            ),
          )
        : undefined;

    // Typed against CardView so the tool cannot drift from the domain's
    // derived-field types (M1.2b).
    const template = cardTemplate(card, authors.templates);
    const derived: Pick<CardView, "waiting_on" | "next_owners" | "why"> =
      deriveCardFields({
        card,
        ...(template === undefined ? {} : { template }),
        work_items,
        assignments,
        deliveries,
        reviews,
        decisions,
        human_actions,
        status,
      });

    const shadow = store.uow.read((tx) =>
      mergeShadowComparisons(
        {
          events: tx.events.listAfter(identity.actor.project_id, cardId, 0),
          decisions: tx.decisions.list(identity.actor.project_id),
        },
        cardId,
      ),
    );
    return {
      merge_shadow: shadow,
      card: {
        ...agentCard(card),
        ...(card.merge_classification
          ? {
              merge_classification: mergeClassificationView(
                { work_items, deliveries },
                card,
              ),
            }
          : {}),
        status,
        stored_status: card.status,
        ...(mergeCheck ? { merge_check: mergeCheck } : {}),
      },
      waiting_on: derived.waiting_on,
      next_owners: derived.next_owners,
      why: derived.why,
      work_items,
      open_decisions: decisions.map((decision) => ({
        ...decision,
        ...decisionAuthorView(authors, decision),
      })),
      deliveries: [...deliveries]
        .sort((left, right) => idNumber(right.id) - idNumber(left.id))
        .slice(0, RECENT_DELIVERY_LIMIT)
        .map((delivery) => ({
          ...summarizeDelivery(delivery),
          ...runAuthorView(authors, delivery.run_id),
        })),
      // The mapping requires every current Git product, including those older
      // than the recent-delivery window. Expose only the host-owned inventory,
      // never unrelated evidence (logs, transport details, etc.).
      role_rule_inventories: roleRuleDeliveries(
        { work_items, deliveries, decisions },
        { card_id: cardId },
      ).map((delivery) => ({
        delivery_id: delivery.id,
        work_item_id: delivery.work_item_id,
        subject: delivery.subject,
        role_rule_inventory: roleRuleInventory(delivery) ?? null,
      })),
      reviews: reviews.map((review) => ({
        ...review,
        ...runAuthorView(authors, review.run_id),
      })),
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
