import {
  type Card,
  type CardDependencyRef,
  type CardDependencyState,
  type CardId,
  cardDependencyComplete,
  deriveCardStatus,
  type Event,
  type ProjectId,
} from "@cardigan/domain";
import type { ReadRepositories, Store } from "@cardigan/store";

/** Page-local cards are insufficient for DAG evidence and successor lengths. */
export function readCardDependencies(
  store: Store,
  tx: ReadRepositories,
  project: ProjectId,
): CardDependencyState | undefined {
  const cards = tx.cards.list(project);
  if (!cards.some((c) => c.depends_on_cards?.length)) return undefined;
  const events = store.database
    .prepare(
      "SELECT doc FROM events WHERE project_id = ? AND type IN ('card_merged','card_marked_done','review_submitted','completion_reviewed','delivery_submitted','review_reused')",
    )
    .all(project)
    .map((row) => JSON.parse(String(row.doc)) as Event);
  return {
    cards,
    events,
    card_templates: tx.card_templates.list(project),
    work_items: tx.work_items.list(project),
    deliveries: tx.deliveries.list(project),
  };
}

export interface CardDependencyGraph {
  readonly nodes: readonly CardDependencyRef[];
  /** `from` must finish before `to` (`to.depends_on_cards` contains `from`). */
  readonly edges: readonly { readonly from: CardId; readonly to: CardId }[];
}

const cardNumber = (id: string) => Number(id.replace(/^\D+/, "")) || 0;

/** The status the card's own detail shows, not the stored column. */
function displayStatus(state: CardDependencyState, card: Card) {
  const items = state.work_items.filter((w) => w.card_id === card.id);
  const itemIds = new Set(items.map((w) => w.id));
  const completion = state.deliveries
    .filter(
      (d) =>
        itemIds.has(d.work_item_id) &&
        d.kind === "card_completion" &&
        d.status !== "superseded",
    )
    .sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0];
  return deriveCardStatus(card.status, items, completion);
}

/**
 * Every transitive prerequisite and dependent of one card, with the edges
 * among them, so the detail graph needs no per-card reads (C-487).
 */
export function cardDependencyGraph(
  state: CardDependencyState,
  card: Card,
): CardDependencyGraph {
  const cards = new Map(
    state.cards
      .filter((c) => c.project_id === card.project_id)
      .map((c) => [c.id, c]),
  );
  cards.set(card.id, card);
  const successors = new Map<CardId, CardId[]>();
  for (const c of cards.values())
    for (const id of new Set(c.depends_on_cards ?? []))
      successors.set(id, [...(successors.get(id) ?? []), c.id]);
  const walk = (next: (id: CardId) => readonly CardId[]) => {
    const seen = new Set<CardId>([card.id]);
    for (const id of seen) for (const n of next(id)) seen.add(n);
    return seen;
  };
  const ids = new Set([
    ...walk((id) => cards.get(id)?.depends_on_cards ?? []),
    ...walk((id) => successors.get(id) ?? []),
  ]);
  const nodes = [...ids]
    .sort((a, b) => cardNumber(a) - cardNumber(b) || a.localeCompare(b))
    .map((id): CardDependencyRef => {
      const c = cards.get(id);
      return c
        ? {
            id: c.id,
            title: c.title,
            status: displayStatus(state, c),
            ...(c.resolution ? { resolution: c.resolution } : {}),
            satisfied: cardDependencyComplete(state, c),
          }
        : { id, title: id, status: "unknown", satisfied: false };
    });
  const edges = nodes.flatMap(({ id }) =>
    [...new Set(cards.get(id)?.depends_on_cards ?? [])]
      .filter((from) => ids.has(from))
      .map((from) => ({ from, to: id })),
  );
  return { nodes, edges };
}
