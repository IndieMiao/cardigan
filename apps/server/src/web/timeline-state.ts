import type { SQLInputValue } from "node:sqlite";
import type { CardId, ProjectId, TimelineEntry } from "@cardigan/domain";
import { storyProgress } from "@cardigan/domain";
import { timeRead } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";
import { readCardDependencies } from "./card-dependencies.js";
import { HttpRejection } from "./http.js";
import { readMergeQueueState } from "./merge-queue-state.js";
import { decodeCursor, encodeCursor, pageLimit } from "./pagination.js";
import { cardDetail } from "./read.js";
import {
  inIds,
  readDocs,
  scopedCardState,
  withReferences,
  withSuggestionProgress,
} from "./sql-state.js";

export function readPagedCard(
  store: Store,
  project: ProjectId,
  cardId: CardId,
  url: URL,
  options: Parameters<typeof cardDetail>[2],
) {
  const params = url.searchParams;
  const limit = pageLimit(params.get("limit"), "timeline");
  const type = params.get("type") || "";
  const author = params.get("author") || "";
  const scope = JSON.stringify([project, "timeline", cardId, type, author]);
  const before = decodeCursor(params.get("before"), scope);
  if (
    before &&
    (before.length !== 1 || typeof before[0] !== "number" || before[0] < 1)
  )
    throw new HttpRejection(400, "validation_failed", "时间线游标无效");
  return store.uow.read((tx) => {
    const timed = <T>(stage: string, fn: () => T) =>
      timeRead(options?.recordTiming, stage, fn);
    let state = timed("sql_state", () =>
      scopedCardState(store, tx, project, [cardId]),
    );
    const card = state.cards.find((c) => c.id === cardId);
    if (!card) return undefined;
    const where = ["project_id = ?", "card_id = ?"];
    const args: SQLInputValue[] = [project, cardId];
    if (type) {
      where.push(
        "CASE WHEN json_extract(doc, '$.type') LIKE 'decision_%' THEN 'decision' WHEN json_extract(doc, '$.type') IN ('system','status_change') THEN 'system' ELSE json_extract(doc, '$.type') END = ?",
      );
      args.push(type);
    }
    if (author) {
      where.push(
        "CASE WHEN json_extract(doc, '$.author') IN ('human','system') THEN json_extract(doc, '$.author') WHEN json_extract(doc, '$.author') IN (SELECT 'assignment:' || id FROM assignments WHERE project_id = ? AND json_extract(doc, '$.role_id') = 'pm') THEN 'pm' ELSE 'agent' END = ?",
      );
      args.push(project, author);
    }
    const total = Number(
      store.database
        .prepare(
          "SELECT count(*) AS n FROM timeline WHERE project_id = ? AND card_id = ?",
        )
        .get(project, cardId)?.n ?? 0,
    );
    if (before) {
      where.push("event_seq < ?");
      args.push(before[0] as number);
    }
    const anchor = params.get("at");
    if (anchor && !before) {
      const queries: [string, string][] = [
        ["entry-", "id"],
        ["delivery-", "json_extract(doc, '$.delivery_id')"],
        ["decision-", "json_extract(doc, '$.decision_id')"],
        ["human-action-", "json_extract(doc, '$.human_action_id')"],
      ];
      let target: { event_seq: number } | undefined;
      for (const [prefix, column] of queries) {
        if (anchor.startsWith(prefix))
          target = store.database
            .prepare(
              `SELECT event_seq FROM timeline WHERE project_id = ? AND card_id = ? AND ${column} = ? ORDER BY event_seq LIMIT 1`,
            )
            .get(project, cardId, anchor.slice(prefix.length)) as typeof target;
      }
      if (anchor.startsWith("review-")) {
        const review = state.reviews.find((r) => r.id === anchor.slice(7));
        if (review)
          target = store.database
            .prepare(
              "SELECT event_seq FROM timeline WHERE project_id = ? AND card_id = ? AND json_extract(doc, '$.type') = 'review' AND json_extract(doc, '$.run_id') = ? AND json_extract(doc, '$.work_item_id') = ? ORDER BY event_seq LIMIT 1",
            )
            .get(
              project,
              cardId,
              review.run_id,
              review.work_item_id,
            ) as typeof target;
      }
      // Anchor windows stay bounded, including a target hidden by a filter.
      if (target) {
        where.splice(2, where.length, "event_seq <= ?");
        args.splice(2, args.length, target.event_seq);
      }
    }
    const rows = store.database
      .prepare(
        `SELECT doc FROM timeline WHERE ${where.join(" AND ")} ORDER BY event_seq DESC LIMIT ?`,
      )
      .all(...args, limit + 1)
      .map((r) => JSON.parse(String(r.doc)) as TimelineEntry);
    const entries = rows.slice(0, limit);
    const conclusions = store.database
      .prepare(
        "SELECT doc FROM timeline WHERE project_id = ? AND card_id = ? AND json_extract(doc, '$.type') IN ('review', 'decision_resolved') AND json_extract(doc, '$.retracted') = 0 ORDER BY event_seq DESC LIMIT 3",
      )
      .all(project, cardId)
      .map((r) => JSON.parse(String(r.doc)) as TimelineEntry);
    state = {
      ...state,
      timeline: [
        ...new Map([...entries, ...conclusions].map((e) => [e.id, e])).values(),
      ],
    };
    state = withReferences(
      store,
      state,
      [
        card.title,
        card.goal,
        ...card.acceptance_criteria,
        ...card.out_of_scope,
        ...state.timeline.map((e) => e.body),
      ].join("\n"),
    );
    state = withSuggestionProgress(store, state);
    const pageEvents = readDocs(
      store,
      project,
      "events",
      `card_id = ? AND ${inIds("seq")}`,
      [
        cardId,
        JSON.stringify(
          state.timeline
            .filter((e) => e.card_id === cardId)
            .map((e) => e.event_seq),
        ),
      ],
    );
    state = {
      ...state,
      events: [
        ...new Map(
          [...state.events, ...pageEvents].map((e) => [e.id, e]),
        ).values(),
      ].sort(
        (a, b) =>
          (a.card_id ?? "").localeCompare(b.card_id ?? "") || a.seq - b.seq,
      ),
    };
    const updatedAt = String(
      store.database
        .prepare(
          "SELECT MAX(json_extract(doc, '$.created_at')) AS at FROM events WHERE project_id = ? AND card_id = ?",
        )
        .get(project, cardId)?.at ?? card.created_at,
    );
    const last = entries.at(-1);
    // Legacy attachments have no card_id. Read only their ownership metadata,
    // independently of the visible timeline window and its filters.
    const attachmentEntryCards = new Map(
      store.database
        .prepare(
          `SELECT id, card_id FROM timeline WHERE project_id = ? AND ${inIds("id")}`,
        )
        .all(
          project,
          JSON.stringify(
            state.attachments.flatMap((a) =>
              !a.card_id && a.attach_to.kind === "timeline_entry"
                ? [a.attach_to.id]
                : [],
            ),
          ),
        )
        .map((row) => [String(row.id), String(row.card_id) as CardId] as const),
    );
    const dependencyState = timed("dependency_sql", () =>
      readCardDependencies(
        store,
        tx,
        project,
        new Set(state.cards.map((c) => c.id)),
      ),
    );
    const mergeState = timed("merge_queue_sql", () =>
      readMergeQueueState(tx, project, { card, state }),
    );
    return timed("assemble", () =>
      cardDetail(state, cardId, {
        ...(card.story
          ? {
              storyProgress: storyProgress(
                readDocs(
                  store,
                  project,
                  "cards",
                  "json_extract(doc, '$.parent_card_id') = ?",
                  [card.id],
                ),
                card,
              ),
            }
          : {}),
        dependencyState,
        mergeState,
        ...options,
        overviewOnly: params.get("section") === "overview",
        updatedAt,
        attachmentEntryCards,
        timelineEntries: entries,
        conclusionEntries: conclusions,
        timelineTotal: total,
        timelineNextCursor:
          rows.length > limit && last
            ? encodeCursor(scope, [last.event_seq])
            : null,
      }),
    );
  });
}
