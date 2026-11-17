import type { CardDependencyState, Event, ProjectId } from "@cardigan/domain";
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
