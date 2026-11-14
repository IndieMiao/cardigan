import type { CommandState, ProjectId } from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { runEvents } from "./execution-state.js";
import { emptyState, inIds, readDocs, scopedCardState } from "./sql-state.js";

const unique = <T extends { readonly id: string }>(
  values: readonly T[],
): T[] => [...new Map(values.map((v) => [v.id, v])).values()];

/** C-243#10: derive the complete small attention set after SQL candidate pruning. */
export function readNeedsState(store: Store, project: ProjectId): CommandState {
  return store.uow.read((tx) => {
    const query = <K extends Parameters<typeof readDocs>[2]>(
      table: K,
      where: string,
      args: Parameters<typeof readDocs>[4] = [],
    ) => readDocs(store, project, table, where, args);
    const activeCards = store.database
      .prepare(
        "SELECT id FROM cards WHERE project_id = ? AND json_extract(doc, '$.status') NOT IN ('done','cancelled')",
      )
      .all(project)
      .map((c) => String(c.id));
    const candidates = JSON.stringify(activeCards);
    const decisions = query(
      "decisions",
      `json_extract(doc, '$.status') IN ('open','provisional','snoozed') OR (json_extract(doc, '$.status') = 'resolved' AND (json_extract(doc, '$.card_id') IS NULL OR ${inIds("json_extract(doc, '$.card_id')")}))`,
      [candidates],
    );
    const actions = query(
      "human_actions",
      `json_extract(doc, '$.status') = 'open' OR (json_extract(doc, '$.status') = 'done' AND (json_extract(doc, '$.card_id') IS NULL OR ${inIds("json_extract(doc, '$.card_id')")}))`,
      [candidates],
    );
    const state = scopedCardState(store, tx, project, [
      ...new Set([
        ...activeCards,
        ...[...decisions, ...actions].flatMap((item) =>
          item.ready_when && item.ready_when.kind !== "manual"
            ? [item.ready_when.card_id]
            : [],
        ),
        ...decisions.flatMap((q) => [
          ...q.affected_cards,
          ...(q.card_id ? [q.card_id] : []),
        ]),
        ...actions.flatMap((h) => (h.card_id ? [h.card_id] : [])),
      ]),
    ]);
    const assignments = unique([
      ...state.assignments,
      ...query("assignments", "json_extract(doc, '$.status') = 'active'"),
      ...query("assignments", inIds("id"), [
        JSON.stringify(
          [
            ...decisions.map((q) => q.raised_by),
            ...actions.map((h) => h.requested_by),
          ].flatMap((a) => (a?.startsWith("assignment:") ? [a.slice(11)] : [])),
        ),
      ]),
    ]);
    const latestRuns = store.database
      .prepare(`SELECT r.doc FROM assignments a JOIN runs r ON r.project_id = a.project_id AND r.id =
      (SELECT id FROM runs WHERE project_id = a.project_id AND assignment_id = a.id AND json_extract(doc, '$.status') IS NOT NULL ORDER BY CAST(substr(id, 3) AS INTEGER) DESC LIMIT 1)
      WHERE a.project_id = ? AND json_extract(a.doc, '$.status') = 'active'`)
      .all(project)
      .map((r) => JSON.parse(String(r.doc))) as CommandState["runs"];
    const noticeEvents = query(
      "events",
      "type IN ('notices_read','decision_resolved','decision_provisionally_resolved','merge_changes_requested','merge_check_requeued','pm_merge_confirmation_stalled','ext_message_failed') AND (type = 'notices_read' OR (type IN ('decision_resolved','decision_provisionally_resolved','merge_changes_requested','merge_check_requeued') AND json_extract(doc, '$.payload.via') = 'delegated') OR type IN ('pm_merge_confirmation_stalled','ext_message_failed'))",
    );
    const runtimeEvents = query(
      "events",
      `type IN ('runtime_disconnected','runtime_reconnected','runtime_exit_observed','runtime_lost') AND ${inIds("json_extract(doc, '$.payload.assignment_id')")}`,
      [
        JSON.stringify(
          assignments.filter((a) => a.status === "active").map((a) => a.id),
        ),
      ],
    );
    const noticeDecisionIds = noticeEvents.flatMap((e) =>
      e.payload && typeof e.payload === "object" && "decision_id" in e.payload
        ? [e.payload.decision_id]
        : [],
    );
    const allDecisions = unique([
      ...state.decisions,
      ...decisions,
      ...query("decisions", inIds("id"), [JSON.stringify(noticeDecisionIds)]),
    ]);
    const decisionIds = JSON.stringify(allDecisions.map((q) => q.id));
    const actionIds = JSON.stringify(actions.map((h) => h.id));
    // Follow-up comments can be on another card; only resolved candidates need them.
    const openings = unique([
      ...query(
        "timeline",
        `json_extract(doc, '$.decision_id') IS NOT NULL AND ${inIds("json_extract(doc, '$.decision_id')")}`,
        [decisionIds],
      ),
      ...query(
        "timeline",
        `json_extract(doc, '$.human_action_id') IS NOT NULL AND ${inIds("json_extract(doc, '$.human_action_id')")}`,
        [actionIds],
      ),
    ]);
    const followups = decisions.filter(
      (q) => q.status === "resolved" && q.resolution,
    );
    const comments = followups.length
      ? query(
          "timeline",
          `json_extract(doc, '$.type') = 'comment' AND json_extract(doc, '$.created_at') >= ? AND EXISTS (SELECT 1 FROM json_each(doc, '$.refs') ref WHERE json_extract(ref.value, '$.kind') = 'decision' AND ${inIds("json_extract(ref.value, '$.id')")})`,
          [
            followups.map((q) => q.resolution?.at ?? "").sort()[0] ?? "",
            JSON.stringify(followups.map((q) => q.id)),
          ],
        )
      : [];
    const timeline = unique([...openings, ...comments]);
    const commentEvents = store.database
      .prepare(
        `SELECT e.doc FROM json_each(?) page CROSS JOIN events e ON e.project_id = ? AND e.stream = json_extract(page.value, '$.card') AND e.seq = json_extract(page.value, '$.seq')`,
      )
      .all(
        JSON.stringify(
          timeline.map((e) => ({ card: e.card_id, seq: e.event_seq })),
        ),
        project,
      )
      .map((r) => JSON.parse(String(r.doc))) as CommandState["events"];
    const projectEvents = query(
      "events",
      `card_id IS NULL AND (type = 'project_preferences_updated' OR ${inIds("json_extract(doc, '$.payload.decision_id')")})`,
      [decisionIds],
    );
    const events = unique([
      ...state.events,
      ...noticeEvents,
      ...runtimeEvents,
      ...commentEvents,
      ...projectEvents,
      ...runEvents(store, project, latestRuns),
    ]).sort(
      (a, b) =>
        (a.card_id ?? "").localeCompare(b.card_id ?? "") || a.seq - b.seq,
    );
    return {
      ...emptyState(tx, project),
      ...state,
      assignments,
      cards: unique([
        ...state.cards,
        ...query("cards", inIds("id"), [
          JSON.stringify(
            allDecisions.flatMap((q) => (q.card_id ? [q.card_id] : [])),
          ),
        ]),
      ]),
      decisions: allDecisions,
      human_actions: unique([...state.human_actions, ...actions]),
      runs: unique([...state.runs, ...latestRuns]),
      events,
      timeline,
      roles: tx.roles.list(project),
    };
  });
}
