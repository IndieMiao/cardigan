import {
  cardTemplate,
  deriveCardStatus,
  deriveNextOwners,
  deriveWaitingOn,
  type ProjectId,
} from "@cardigan/domain";
import type { ReadRepositories } from "@cardigan/store";

/** Only workflow facts needed by filters/counts. No events, runs, prose views,
 * attachment ownership, author identities, review matrices or merge checks.
 * Keep the domain's current-target and fixed-template rules in one place.
 */
export function cardSelectors(tx: ReadRepositories, project: ProjectId) {
  const items = tx.work_items.list(project);
  const deliveries = tx.deliveries.list(project);
  const reviews = tx.reviews.list(project);
  const decisions = tx.decisions.list(project);
  const actions = tx.human_actions.list(project);
  const templates = tx.card_templates.list(project);
  return tx.cards
    .list(project)
    .filter((c) => !["done", "cancelled"].includes(c.status))
    .map((card) => {
      const work_items = items.filter((w) => w.card_id === card.id);
      const ids = new Set(work_items.map((w) => w.id));
      const ownDeliveries = deliveries.filter((d) => ids.has(d.work_item_id));
      const completion = ownDeliveries
        .filter(
          (d) => d.kind === "card_completion" && d.status !== "superseded",
        )
        .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
      const status = deriveCardStatus(card.status, work_items, completion);
      const template = cardTemplate(card, templates);
      const input = {
        card,
        status,
        work_items,
        deliveries: ownDeliveries,
        reviews: reviews.filter((r) => ids.has(r.work_item_id)),
        decisions: decisions.filter(
          (q) => q.card_id === card.id || q.affected_cards.includes(card.id),
        ),
        human_actions: actions.filter(
          (h) =>
            h.card_id === card.id ||
            h.blocked_work_items.some((id) => ids.has(id)),
        ),
        ...(template ? { template } : {}),
      };
      const owners = deriveNextOwners(input);
      const waiting = deriveWaitingOn(input);
      return {
        id: card.id,
        status,
        held: Number(Boolean(card.hold)),
        needs_me: Number(!card.hold && owners.some((o) => o.kind === "human")),
        agent: Number(
          !card.hold &&
            owners.some((o) => o.kind === "role" || o.kind === "assignment"),
        ),
        human: Number(
          owners.some((o) => o.kind === "human") ||
            waiting.some((w) => ["decision", "human_action"].includes(w.kind)),
        ),
        blocked: Number(
          waiting.some((w) => ["blocked", "review"].includes(w.kind)),
        ),
      };
    });
}
