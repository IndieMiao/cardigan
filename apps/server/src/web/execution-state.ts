import type { CommandState, ProjectId } from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { HttpRejection } from "./http.js";
import { PAGE_LIMITS, pageLimit } from "./pagination.js";
import { readWorkbenchQueue } from "./queue-state.js";
import {
  type ExecutionContexts,
  executionRunPage,
  executionView,
} from "./read.js";
import { emptyState, inIds, readDocs } from "./sql-state.js";

export function runEvents(
  store: Store,
  project: ProjectId,
  runs: CommandState["runs"],
) {
  const triggers = readDocs(store, project, "events", inIds("id"), [
    JSON.stringify(runs.map((r) => r.trigger_event_id)),
  ]);
  const queued = readDocs(
    store,
    project,
    "events",
    `type IN ('run_queued', 'run_started') AND ${inIds("json_extract(doc, '$.payload.run_id')")}`,
    [JSON.stringify(runs.map((r) => r.id))],
  );
  return [
    ...new Map([...triggers, ...queued].map((e) => [e.id, e])).values(),
  ].sort(
    (a, b) => (a.card_id ?? "").localeCompare(b.card_id ?? "") || a.seq - b.seq,
  );
}

export function readExecution(
  store: Store,
  project: ProjectId,
  url: URL,
  now: string,
  warning?: number,
  contexts?: ExecutionContexts,
) {
  const limit = pageLimit(url.searchParams.get("limit"), "execution");
  return store.uow.read((tx) => {
    const assignments = readDocs(
      store,
      project,
      "assignments",
      "json_extract(doc, '$.status') = 'active'",
    );
    const latest = store.database
      .prepare(`SELECT r.doc FROM assignments a JOIN runs r ON r.project_id = a.project_id AND r.id =
      (SELECT id FROM runs WHERE project_id = a.project_id AND assignment_id = a.id AND json_extract(doc, '$.status') IS NOT NULL ORDER BY CAST(substr(id, 3) AS INTEGER) DESC LIMIT 1)
      WHERE a.project_id = ? AND json_extract(a.doc, '$.status') = 'active'`)
      .all(project)
      .map((r) => JSON.parse(String(r.doc))) as CommandState["runs"];
    const recent = store.database
      .prepare(
        "SELECT doc FROM runs WHERE project_id = ? AND json_extract(doc, '$.status') IS NOT NULL ORDER BY CAST(substr(id, 3) AS INTEGER) DESC LIMIT ?",
      )
      .all(project, limit)
      .map((r) => JSON.parse(String(r.doc))) as CommandState["runs"];
    const runs = [
      ...new Map([...latest, ...recent].map((r) => [r.id, r])).values(),
    ];
    const work_items = readDocs(store, project, "work_items", inIds("id"), [
      JSON.stringify(
        assignments.flatMap((a) => (a.work_item_id ? [a.work_item_id] : [])),
      ),
    ]);
    const reviewCards = new Set(
      work_items.filter((w) => w.kind === "verify").map((w) => w.card_id),
    );
    const targets = readDocs(store, project, "work_items", inIds("card_id"), [
      JSON.stringify([...reviewCards]),
    ]);
    const deliveries = readDocs(
      store,
      project,
      "deliveries",
      inIds("json_extract(doc, '$.work_item_id')"),
      [JSON.stringify(targets.map((w) => w.id))],
    );
    const reviews = readDocs(
      store,
      project,
      "reviews",
      inIds("json_extract(doc, '$.work_item_id')"),
      [
        JSON.stringify(
          work_items.filter((w) => w.kind === "verify").map((w) => w.id),
        ),
      ],
    );
    const targetEvents = readDocs(
      store,
      project,
      "events",
      `type = 'delivery_submitted' AND ${inIds("card_id")}`,
      [JSON.stringify([...reviewCards])],
    );
    const generation = store.database.prepare(`SELECT doc FROM events
      WHERE project_id = ? AND json_extract(doc, '$.payload.assignment_id') = ?
      AND type IN ('session_replaced', 'standing_session_restarted', 'assignment_resumed', 'host_ops_action_finished')
      ORDER BY json_extract(doc, '$.created_at') DESC LIMIT 1`);
    const generations = assignments.flatMap((a) => {
      if (!contexts?.has(a.id)) return [];
      const row = generation.get(project, a.id);
      return row
        ? [JSON.parse(String(row.doc)) as CommandState["events"][number]]
        : [];
    });
    const state = {
      ...emptyState(tx, project),
      assignments,
      runs,
      work_items,
      deliveries,
      reviews,
      cards: readDocs(store, project, "cards", inIds("id"), [
        JSON.stringify(work_items.map((w) => w.card_id)),
      ]),
      cursors: readDocs(store, project, "cursors", inIds("assignment_id"), [
        JSON.stringify(assignments.map((a) => a.id)),
      ]),
      events: [
        ...new Map(
          [
            ...runEvents(store, project, runs),
            ...targetEvents,
            ...generations,
          ].map((e) => [e.id, e]),
        ).values(),
      ],
    };
    const view = executionView(
      state,
      now,
      tx.machines.list(project),
      readWorkbenchQueue(store, tx),
      warning,
      contexts,
    );
    const recentIds = new Set(recent.map((r) => r.id));
    return { ...view, runs: view.runs.filter((r) => recentIds.has(r.id)) };
  });
}

export function readExecutionRuns(
  store: Store,
  project: ProjectId,
  assignmentId: string,
  before?: string,
) {
  return store.uow.read((tx) => {
    const assignments = readDocs(store, project, "assignments", "id = ?", [
      assignmentId,
    ]);
    if (!assignments.length) return undefined;
    const anchor = before
      ? store.database
          .prepare(
            "SELECT CAST(substr(id, 3) AS INTEGER) AS n FROM runs WHERE project_id = ? AND assignment_id = ? AND id = ?",
          )
          .get(project, assignmentId, before)
      : undefined;
    if (before !== undefined && !anchor)
      throw new HttpRejection(
        400,
        "validation_failed",
        "Run 历史分页游标无效，请刷新后重试",
      );
    const runs = store.database
      .prepare(
        `SELECT doc FROM runs WHERE project_id = ? AND assignment_id = ? AND json_extract(doc, '$.status') IS NOT NULL ${anchor ? "AND CAST(substr(id, 3) AS INTEGER) < ?" : ""} ORDER BY CAST(substr(id, 3) AS INTEGER) DESC LIMIT ?`,
      )
      .all(
        project,
        assignmentId,
        ...(anchor ? [Number(anchor.n)] : []),
        PAGE_LIMITS.runs.default + 1,
      )
      .map((r) => JSON.parse(String(r.doc))) as CommandState["runs"];
    const state = {
      ...emptyState(tx, project),
      assignments,
      runs,
      events: runEvents(store, project, runs),
    };
    const page = executionRunPage(
      state,
      assignmentId,
      undefined,
      readWorkbenchQueue(store, tx),
    );
    return {
      ...page,
      total: Number(
        store.database
          .prepare(
            "SELECT COUNT(*) AS n FROM runs WHERE project_id = ? AND assignment_id = ?",
          )
          .get(project, assignmentId)?.n ?? 0,
      ),
    };
  });
}
