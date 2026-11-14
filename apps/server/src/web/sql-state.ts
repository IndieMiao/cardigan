import type { SQLInputValue } from "node:sqlite";
import {
  type CommandState,
  extractReferences,
  type ProjectId,
} from "@cardigan/domain";
import type { ReadRepositories, Store } from "@cardigan/store";

type Collection =
  | "cards"
  | "work_items"
  | "assignments"
  | "runs"
  | "deliveries"
  | "reviews"
  | "decisions"
  | "human_actions"
  | "attachments"
  | "timeline"
  | "events"
  | "cursors";

/** Only trusted query fragments enter here; all request values are bound parameters. */
export function readDocs<K extends Collection>(
  store: Store,
  project: ProjectId,
  table: K,
  where: string,
  args: readonly SQLInputValue[] = [],
): CommandState[K] {
  return store.database
    .prepare(`SELECT doc FROM ${table} WHERE project_id = ? AND (${where})`)
    .all(project, ...args)
    .map((row) => JSON.parse(String(row.doc))) as CommandState[K];
}

export function emptyState(
  tx: ReadRepositories,
  project_id: ProjectId,
): CommandState {
  return {
    project_id,
    project_preferences: tx.project_preferences.list(project_id),
    card_templates: tx.card_templates.list(project_id),
    employees: tx.employees.list(),
    members: tx.members.list(),
    cards: [],
    work_items: [],
    assignments: [],
    runs: [],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    attachments: [],
    timeline: [],
    events: [],
    cursors: [],
    roles: [],
  };
}

export const inIds = (column: string) =>
  `${column} IN (SELECT value FROM json_each(?))`;

export function withAuthors(
  store: Store,
  state: CommandState,
  authors: readonly string[],
): CommandState {
  const ids = authors
    .filter((a) => a.startsWith("assignment:"))
    .map((a) => a.slice(11));
  return {
    ...state,
    assignments: readDocs(store, state.project_id, "assignments", inIds("id"), [
      JSON.stringify(ids),
    ]),
  };
}

const unique = <T extends { readonly id: string }>(
  values: readonly T[],
): T[] => [...new Map(values.map((v) => [v.id, v])).values()];

/** Domain presentation still receives all dependencies of the selected cards. */
export function scopedCardState(
  store: Store,
  tx: ReadRepositories,
  project: ProjectId,
  ids: readonly string[],
): CommandState {
  const query = <K extends Collection>(
    table: K,
    where: string,
    args: readonly SQLInputValue[] = [],
  ) => readDocs(store, project, table, where, args);
  let cards = query("cards", inIds("id"), [JSON.stringify(ids)]);
  const sourceIds = cards.flatMap((c) =>
    c.source.kind === "decision" ? [c.source.decision_id] : [],
  );
  const sourceDecisions = query("decisions", inIds("id"), [
    JSON.stringify(sourceIds),
  ]);
  const related = cards
    .flatMap((c) => c.related_cards)
    .concat(sourceDecisions.flatMap((q) => (q.card_id ? [q.card_id] : [])));
  cards = unique([
    ...cards,
    ...query("cards", inIds("id"), [JSON.stringify(related)]),
  ]);
  const cardIds = JSON.stringify(cards.map((c) => c.id));
  let work_items = query("work_items", inIds("card_id"), [cardIds]);
  const itemIds = JSON.stringify(work_items.map((w) => w.id));
  const decisions = unique([
    ...sourceDecisions,
    ...query(
      "decisions",
      `${inIds("json_extract(doc, '$.card_id')")} OR EXISTS (SELECT 1 FROM json_each(doc, '$.affected_cards') WHERE ${inIds("value")}) OR EXISTS (SELECT 1 FROM json_each(doc, '$.affected_work_items') WHERE ${inIds("value")})`,
      [cardIds, cardIds, itemIds],
    ),
  ]);
  const human_actions = query(
    "human_actions",
    `${inIds("json_extract(doc, '$.card_id')")} OR EXISTS (SELECT 1 FROM json_each(doc, '$.blocked_work_items') WHERE ${inIds("value")})`,
    [cardIds, itemIds],
  );
  // affects() resolves every explicitly affected work item, even on another card.
  work_items = unique([
    ...work_items,
    ...query("work_items", inIds("id"), [
      JSON.stringify([
        ...decisions.flatMap((q) => q.affected_work_items),
        ...work_items.flatMap((w) => w.depends_on),
        ...human_actions.flatMap((h) => h.blocked_work_items),
      ]),
    ]),
  ]);
  const dependencies = [
    ...decisions.flatMap((q) => q.affected_cards),
    ...work_items.map((w) => w.card_id),
    ...[...decisions, ...human_actions].flatMap((item) =>
      item.ready_when && item.ready_when.kind !== "manual"
        ? [item.ready_when.card_id]
        : [],
    ),
  ];
  const missing = dependencies.filter((id) => !cards.some((c) => c.id === id));
  if (missing.length) {
    const existing = query("cards", inIds("id"), [JSON.stringify(missing)]);
    if (existing.length)
      return scopedCardState(store, tx, project, [
        ...new Set([...cards.map((c) => c.id), ...existing.map((c) => c.id)]),
      ]);
  }
  const deliveries = query("deliveries", inIds("work_item_id"), [itemIds]);
  const reviews = query(
    "reviews",
    `${inIds("delivery_id")} OR ${inIds("json_extract(doc, '$.work_item_id')")}`,
    [JSON.stringify(deliveries.map((d) => d.id)), itemIds],
  );
  const runs = query("runs", inIds("id"), [
    JSON.stringify([
      ...deliveries.map((d) => d.run_id),
      ...reviews.map((r) => r.run_id),
    ]),
  ]);
  const authors = [
    ...decisions.map((q) => q.raised_by),
    ...human_actions.map((h) => h.requested_by),
  ].flatMap((a) => (a?.startsWith("assignment:") ? [a.slice(11)] : []));
  const assignments = query(
    "assignments",
    `${inIds("json_extract(doc, '$.work_item_id')")} OR ${inIds("id")} OR (json_extract(doc, '$.scope') = 'standing' AND json_extract(doc, '$.status') = 'active')`,
    [
      JSON.stringify(work_items.map((w) => w.id)),
      JSON.stringify([...runs.map((r) => r.assignment_id), ...authors]),
    ],
  );
  const attachmentIds = JSON.stringify(
    decisions.flatMap((q) => q.attachment_ids ?? []),
  );
  const attachments = query(
    "attachments",
    `${inIds("json_extract(doc, '$.card_id')")} OR ${inIds("id")} OR (json_extract(doc, '$.card_id') IS NULL AND json_extract(doc, '$.attach_to.kind') = 'timeline_entry' AND json_extract(doc, '$.attach_to.id') IN (SELECT id FROM timeline WHERE project_id = ? AND ${inIds("card_id")}))`,
    [cardIds, attachmentIds, project, cardIds],
  );
  const events = query(
    "events",
    `(${inIds("card_id")} OR ${inIds("json_extract(doc, '$.payload.decision_id')")} OR ${inIds("json_extract(doc, '$.payload.attachment_id')")}) AND type NOT IN ('comment_posted', 'comment_added') AND type NOT LIKE 'run_%' AND type NOT LIKE 'bell_%'`,
    [
      cardIds,
      JSON.stringify(decisions.map((q) => q.id)),
      JSON.stringify(attachments.map((a) => a.id)),
    ],
  );
  return {
    ...emptyState(tx, project),
    cards,
    work_items,
    assignments,
    deliveries,
    reviews,
    decisions,
    human_actions,
    runs,
    attachments,
    events: [...events].sort(
      (a, b) =>
        (a.card_id ?? "").localeCompare(b.card_id ?? "") || a.seq - b.seq,
    ),
  };
}

/** Resolve explicit references without loading unrelated project collections. */
export function withReferences(
  store: Store,
  state: CommandState,
  text: string,
): CommandState {
  const tables = {
    card: "cards",
    work_item: "work_items",
    assignment: "assignments",
    run: "runs",
    delivery: "deliveries",
    review: "reviews",
    decision: "decisions",
    human_action: "human_actions",
    timeline_entry: "timeline",
  } as const;
  const refs = extractReferences(text);
  const next = { ...state };
  for (const [kind, table] of Object.entries(tables)) {
    const ids = refs
      .filter((r) => r.kind === kind && "id" in r)
      .map((r) => ("id" in r ? r.id : ""));
    if (ids.length) {
      const found = readDocs(store, state.project_id, table, inIds("id"), [
        JSON.stringify(ids),
      ]);
      Object.assign(next, { [table]: unique([...state[table], ...found]) });
    }
  }
  const query = <K extends Collection>(table: K, ids: readonly string[]) =>
    readDocs(store, state.project_id, table, inIds("id"), [
      JSON.stringify(ids),
    ]);
  next.deliveries = unique([
    ...next.deliveries,
    ...query(
      "deliveries",
      next.reviews.map((r) => r.delivery_id),
    ),
  ]);
  next.assignments = unique([
    ...next.assignments,
    ...query(
      "assignments",
      next.runs.map((r) => r.assignment_id),
    ),
  ]);
  next.work_items = unique([
    ...next.work_items,
    ...query("work_items", [
      ...next.assignments.flatMap((a) =>
        a.work_item_id ? [a.work_item_id] : [],
      ),
      ...next.deliveries.map((d) => d.work_item_id),
      ...next.reviews.map((r) => r.work_item_id),
      ...next.decisions.flatMap((q) => q.affected_work_items),
    ]),
  ]);
  next.cards = unique([
    ...next.cards,
    ...query(
      "cards",
      next.work_items.map((w) => w.card_id),
    ),
  ]);
  const authorIds = next.timeline
    .map((e) => e.author)
    .filter((a) => a.startsWith("assignment:"))
    .map((a) => a.slice(11));
  next.assignments = unique([
    ...next.assignments,
    ...readDocs(store, state.project_id, "assignments", inIds("id"), [
      JSON.stringify(authorIds),
    ]),
  ]);
  return next;
}
