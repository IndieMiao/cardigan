import type { SQLInputValue } from "node:sqlite";
import {
  attachmentRefMatches,
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

/** C-303: load only evidence after pending suggestions' per-card baselines. */
export function withSuggestionProgress(
  store: Store,
  state: CommandState,
): CommandState {
  const baselines = new Map<string, number>();
  for (const q of state.decisions) {
    if (!["open", "provisional", "snoozed", "resolved"].includes(q.status))
      continue;
    for (const id of new Set([q.card_id, ...q.affected_cards])) {
      if (!id || !state.cards.some((c) => c.id === id)) continue;
      const seq = q.suggestion?.evidence_baseline?.[id];
      if (seq !== undefined)
        baselines.set(id, Math.min(seq, baselines.get(id) ?? seq));
    }
  }
  if (!baselines.size) return state;
  const events = store.database
    .prepare(`SELECT e.doc FROM json_each(?) b
    JOIN events e ON e.project_id = ? AND e.stream = b.key AND e.seq > b.value
    WHERE e.type IN ('comment_posted','merge_check_finished','delivery_submitted',
      'review_submitted','completion_reviewed','human_action_completed')`)
    .all(JSON.stringify(Object.fromEntries(baselines)), state.project_id)
    .map((r) => JSON.parse(String(r.doc))) as CommandState["events"];
  const visible = events.filter(
    (e) => !state.cards.find((c) => c.id === e.card_id)?.sensitive,
  );
  const timeline = store.database
    .prepare(`SELECT t.doc FROM json_each(?) e
    JOIN timeline t ON t.project_id = ? AND t.card_id = json_extract(e.value, '$.card_id')
      AND t.event_seq = json_extract(e.value, '$.seq')`)
    .all(
      JSON.stringify(visible.map((e) => ({ card_id: e.card_id, seq: e.seq }))),
      state.project_id,
    )
    .map((r) => JSON.parse(String(r.doc))) as CommandState["timeline"];
  const authors = events.flatMap((e) =>
    e.actor.kind === "assignment" ? [e.actor.assignment_id] : [],
  );
  return {
    ...state,
    events: unique([...state.events, ...events]),
    timeline: unique([...state.timeline, ...timeline]),
    assignments: unique([
      ...state.assignments,
      ...readDocs(store, state.project_id, "assignments", inIds("id"), [
        JSON.stringify(authors),
      ]),
    ]),
  };
}

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
    .flatMap((c) =>
      c.parent_card_id
        ? [...c.related_cards, c.parent_card_id]
        : c.related_cards,
    )
    .concat(sourceDecisions.flatMap((q) => (q.card_id ? [q.card_id] : [])));
  cards = unique([
    ...cards,
    ...query("cards", inIds("id"), [JSON.stringify(related)]),
  ]);
  const cardIds = JSON.stringify(cards.map((c) => c.id));
  const cardSet = new Set(cards.map((c) => c.id));
  let work_items = query("work_items", inIds("card_id"), [cardIds]);
  const itemIds = JSON.stringify(work_items.map((w) => w.id));
  const itemSet = new Set(work_items.map((w) => w.id));
  // C-688: array membership and OR across keys cannot seek an index, so SQL
  // parsed every decision, human action, assignment and attachment document
  // of the project on each read. Filter the transaction's cached collections
  // instead: same rows, same (primary/activity index) order, and only changed
  // rows are decoded again.
  const decisions = unique([
    ...sourceDecisions,
    ...tx.decisions
      .list(project)
      .filter(
        (q) =>
          (q.card_id != null && cardSet.has(q.card_id)) ||
          (q.affected_cards ?? []).some((id) => cardSet.has(id)) ||
          (q.affected_work_items ?? []).some((id) => itemSet.has(id)),
      ),
  ]);
  const human_actions = tx.human_actions
    .list(project)
    .filter(
      (h) =>
        (h.card_id != null && cardSet.has(h.card_id)) ||
        (h.blocked_work_items ?? []).some((id) => itemSet.has(id)),
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
  // Seek each alternative independently. Factoring project_id around OR makes
  // SQLite scan the project's history instead of seeking both object keys.
  // Union rowids (not JSON documents) to deduplicate cheap identities, retaining
  // the previous delivery/assignment index order for downstream tie handling.
  const alternatives = <K extends "reviews" | "runs">(
    table: K,
    selectors: readonly [string, readonly SQLInputValue[]][],
    order: string,
  ): CommandState[K] =>
    store.database
      .prepare(
        `SELECT doc FROM ${table} WHERE rowid IN (${selectors
          .map(
            ([where]) =>
              `SELECT rowid FROM ${table} WHERE project_id = ? AND (${where})`,
          )
          .join(" UNION ")}) ORDER BY ${order}`,
      )
      .all(...selectors.flatMap(([, args]) => [project, ...args]))
      .map((row) => JSON.parse(String(row.doc))) as CommandState[K];
  const reviews = alternatives(
    "reviews",
    [
      [inIds("delivery_id"), [JSON.stringify(deliveries.map((d) => d.id))]],
      [inIds("json_extract(doc, '$.work_item_id')"), [itemIds]],
    ],
    "delivery_id, rowid",
  );
  const runs = alternatives(
    "runs",
    [
      [
        inIds("id"),
        [
          JSON.stringify([
            ...deliveries.map((d) => d.run_id),
            ...reviews.map((r) => r.run_id),
          ]),
        ],
      ],
      [
        `${inIds("assignment_id")} AND json_extract(doc, '$.status') NOT IN ('completed','failed','cancelled')`,
        [
          JSON.stringify(
            work_items.flatMap((w) =>
              w.assignment_id ? [w.assignment_id] : [],
            ),
          ),
        ],
      ],
    ],
    "assignment_id, trigger_event_id",
  );
  const authors = [
    ...decisions.map((q) => q.raised_by),
    ...human_actions.map((h) => h.requested_by),
  ].flatMap((a) => (a?.startsWith("assignment:") ? [a.slice(11)] : []));
  const assignmentItems = new Set(work_items.map((w) => w.id));
  const assignmentIds = new Set([
    ...runs.map((r) => r.assignment_id),
    ...authors,
  ]);
  const assignments = tx.assignments
    .list(project)
    .filter(
      (a) =>
        (a.work_item_id != null && assignmentItems.has(a.work_item_id)) ||
        assignmentIds.has(a.id) ||
        (a.scope === "standing" && a.status === "active"),
    );
  const attachmentIds = new Set(
    decisions.flatMap((q) => q.attachment_ids ?? []),
  );
  const projectAttachments = tx.attachments.list(project);
  // Legacy attachments have no card_id: they belong to a card through the
  // timeline entry they are attached to.
  const legacyEntries = projectAttachments.flatMap((a) =>
    a.card_id == null && a.attach_to.kind === "timeline_entry"
      ? [a.attach_to.id]
      : [],
  );
  const legacyOwned = new Set(
    legacyEntries.length
      ? store.database
          .prepare(
            `SELECT id FROM timeline WHERE project_id = ? AND ${inIds("id")} AND ${inIds("card_id")}`,
          )
          .all(project, JSON.stringify(legacyEntries), cardIds)
          .map((row) => String(row.id))
      : [],
  );
  const attachments = projectAttachments.filter((a) =>
    a.card_id == null
      ? attachmentIds.has(a.id) ||
        (a.attach_to.kind === "timeline_entry" &&
          legacyOwned.has(a.attach_to.id))
      : cardSet.has(a.card_id) || attachmentIds.has(a.id),
  );
  // Separate object selectors let SQLite seek each index by project AND object.
  // A single OR across these keys otherwise scans all events in the project.
  const events = unique(
    (
      [
        ["card_id", cardIds],
        [
          "json_extract(doc, '$.payload.decision_id')",
          JSON.stringify(decisions.map((q) => q.id)),
        ],
        [
          "json_extract(doc, '$.payload.attachment_id')",
          JSON.stringify(attachments.map((a) => a.id)),
        ],
      ] as const
    ).flatMap(([column, ids]) =>
      query(
        "events",
        `${inIds(column)} AND type NOT IN ('comment_posted', 'comment_added') AND type NOT LIKE 'run_%' AND type NOT LIKE 'bell_%'`,
        [ids],
      ),
    ),
  );
  const activeRunIds = runs
    .filter((r) => ["acked", "running", "unknown"].includes(r.status))
    .map((r) => r.id);
  const starts = activeRunIds.length
    ? query(
        "events",
        `type = 'run_started' AND ${inIds("json_extract(doc, '$.payload.run_id')")}`,
        [JSON.stringify(activeRunIds)],
      )
    : [];
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
    events: unique([...events, ...starts]).sort(
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
  // C-615: `attachment-N` in a body, with the card it belongs to, so its
  // sensitivity can be checked before the browser gets its metadata.
  // `text` joins many bodies, so code is not masked here (one body's open
  // fence would hide the rest): this only loads candidates, and
  // `referencedAttachmentViews` decides per body which ones are references.
  const attachmentIds = [
    ...new Set(
      attachmentRefMatches(text, { literals: false })
        .filter((m) => !m.pending)
        .map((m) => m.token),
    ),
  ];
  if (attachmentIds.length) {
    next.attachments = unique([
      ...next.attachments,
      ...query("attachments", attachmentIds),
    ]);
    next.cards = unique([
      ...next.cards,
      ...query(
        "cards",
        next.attachments.flatMap((a) => (a.card_id ? [a.card_id] : [])),
      ),
    ]);
  }
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
  const authorIds = [
    ...next.timeline.map((e) => e.author),
    ...next.attachments.map((a) => a.uploaded_by),
  ]
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
