import type {
  CardId,
  CommandState,
  ProjectId,
  TimelineEntry,
} from "@cardigan/domain";
import { extractReferences } from "@cardigan/domain";
import type { ReadRepositories, Store } from "@cardigan/store";
import { cardDetail, cardListViews } from "./read.js";

/** Only collections used by card views; command-only activity/cursors stay out. */
function cardState(tx: ReadRepositories, project_id: ProjectId): CommandState {
  return {
    project_id,
    cards: tx.cards.list(project_id),
    card_templates: tx.card_templates.list(project_id),
    employees: tx.employees.list(),
    work_items: tx.work_items.list(project_id),
    assignments: tx.assignments.list(project_id),
    deliveries: tx.deliveries.list(project_id),
    reviews: tx.reviews.list(project_id),
    decisions: tx.decisions.list(project_id),
    human_actions: tx.human_actions.list(project_id),
    roles: [],
    runs: [],
    attachments: [],
    cursors: [],
    timeline: [],
    events: [],
  };
}

export function readCardList(store: Store, project_id: ProjectId) {
  return store.uow.read((tx) => {
    const state = cardState(tx, project_id);
    // Timestamps are the list's only event data. Aggregate in SQLite instead of
    // transferring and parsing every event payload (including delivery evidence).
    const rows = store.database
      .prepare(
        "SELECT card_id, MAX(json_extract(doc, '$.created_at')) AS updated_at " +
          "FROM events WHERE project_id = ? AND card_id IS NOT NULL GROUP BY card_id",
      )
      .all(project_id) as { card_id: string; updated_at: string }[];
    return cardListViews(
      state,
      new Map(rows.map((row) => [row.card_id, row.updated_at])),
    );
  });
}

export function readCardDetail(
  store: Store,
  project_id: ProjectId,
  card_id: CardId,
  options: Parameters<typeof cardDetail>[2] = {},
) {
  return store.uow.read((tx) => {
    const state = cardState(tx, project_id);
    const card = state.cards.find((c) => c.id === card_id);
    if (!card) return undefined;
    const timeline = store.database
      .prepare(
        "SELECT doc FROM timeline WHERE project_id = ? AND card_id = ? ORDER BY event_seq",
      )
      .all(project_id, card_id)
      .map((row) => JSON.parse(row.doc as string) as TimelineEntry);
    // Preserve cross-card entry links without loading every timeline body.
    const references = extractReferences(
      [
        card.title,
        card.goal,
        ...card.acceptance_criteria,
        ...card.out_of_scope,
        ...timeline.map((entry) => entry.body),
      ].join("\n"),
    );
    const entryIds = new Set(timeline.map((entry) => entry.id));
    for (const ref of references) {
      if (ref.kind !== "timeline_entry" || entryIds.has(ref.id)) continue;
      const entry = tx.timeline.get(project_id, ref.id);
      if (entry) timeline.push(entry);
    }
    const events = tx.events.listAfter(project_id, card_id, 0);
    // Legacy attachments can be attached to this timeline with another card_id.
    // Their upload timestamp must still come from the original event stream.
    const uploads = store.database
      .prepare(
        "SELECT doc FROM events WHERE project_id = ? AND type = 'attachment_uploaded' AND stream <> ?",
      )
      .all(project_id, card_id)
      .map(
        (row) =>
          JSON.parse(row.doc as string) as CommandState["events"][number],
      );
    return cardDetail(
      {
        ...state,
        runs: tx.runs.list(project_id),
        attachments: tx.attachments.list(project_id),
        timeline,
        events: [...events, ...uploads],
      },
      card_id,
      options,
    );
  });
}
