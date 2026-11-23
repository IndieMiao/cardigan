import type { SQLInputValue } from "node:sqlite";
import {
  type Decision,
  decisionCategories,
  type ProjectId,
} from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { HttpRejection } from "./http.js";
import { decodeCursor, encodeCursor, pageLimit } from "./pagination.js";
import { webDecisionView } from "./read.js";
import { scopedCardState, withAuthors } from "./sql-state.js";

export function readDecisionHistory(
  store: Store,
  project: ProjectId,
  url: URL,
) {
  const params = url.searchParams;
  const limit = pageLimit(params.get("limit"), "decisions");
  const filters = Object.fromEntries(
    ["decider", "category", "card_id", "from", "to"].map((k) => [
      k,
      params.get(k) || "",
    ]),
  );
  if (
    (filters.decider && !["human", "pm", "system"].includes(filters.decider)) ||
    (filters.category &&
      !decisionCategories.includes(filters.category as never)) ||
    [filters.from, filters.to].some((v) => v && !Number.isFinite(Date.parse(v)))
  )
    throw new HttpRejection(400, "validation_failed", "拍板记录筛选条件无效");
  const scope = JSON.stringify([project, "decisions", filters]);
  const cursor = decodeCursor(params.get("cursor"), scope);
  if (
    cursor &&
    (cursor.length !== 2 || cursor.some((v) => typeof v !== "string"))
  )
    throw new HttpRejection(400, "validation_failed", "拍板记录游标无效");
  const at = "json_extract(d.doc, '$.resolution.at')";
  const maker =
    "CASE WHEN json_extract(d.doc, '$.resolution.resolved_by') = 'system' THEN 'system' WHEN json_extract(d.doc, '$.resolution.owner_record') IS NOT NULL THEN 'human' WHEN json_extract(d.doc, '$.resolution.via') = 'delegated' THEN 'pm' ELSE 'human' END";
  const where = [
    "d.project_id = ?",
    `${at} IS NOT NULL`,
    `(json_extract(d.doc, '$.status') = 'resolved' OR (json_extract(d.doc, '$.status') IN ('superseded','revoked') AND EXISTS (SELECT 1 FROM events e WHERE e.project_id = d.project_id AND json_extract(e.doc, '$.payload.decision_id') = d.id AND e.type = 'decision_resolved' AND json_extract(e.doc, '$.created_at') = ${at})))`,
  ];
  const args: SQLInputValue[] = [project];
  if (filters.decider) {
    where.push(`${maker} = ?`);
    args.push(filters.decider);
  }
  if (filters.category) {
    where.push("COALESCE(json_extract(d.doc, '$.category'), 'general') = ?");
    args.push(filters.category);
  }
  if (filters.card_id) {
    where.push(
      "(json_extract(d.doc, '$.card_id') = ? OR EXISTS (SELECT 1 FROM json_each(d.doc, '$.affected_cards') WHERE value = ?))",
    );
    args.push(filters.card_id, filters.card_id);
  }
  if (filters.from) {
    where.push(`${at} >= ?`);
    args.push(new Date(filters.from).toISOString());
  }
  if (filters.to) {
    where.push(`${at} <= ?`);
    args.push(new Date(filters.to).toISOString());
  }
  if (cursor) {
    where.push(`(${at}, d.id) < (?, ?)`);
    args.push(...cursor);
  }
  return store.uow.read((tx) => {
    const rows = store.database
      .prepare(
        `SELECT d.doc, ${maker} AS decision_maker FROM decisions d WHERE ${where.join(" AND ")} ORDER BY ${at} DESC, d.id DESC LIMIT ?`,
      )
      .all(...args, limit + 1)
      .map((row) => ({
        ...(JSON.parse(String(row.doc)) as Decision & {
          resolution: NonNullable<Decision["resolution"]>;
        }),
        decision_maker: String(row.decision_maker),
      }));
    const page = rows.slice(0, limit);
    const state = scopedCardState(
      store,
      tx,
      project,
      page.flatMap((q) => [
        ...q.affected_cards,
        ...(q.card_id ? [q.card_id] : []),
      ]),
    );
    const authored = withAuthors(store, state, [
      ...state.assignments.map((a) => `assignment:${a.id}`),
      ...page.flatMap((q) => [
        q.raised_by ?? "system",
        q.resolution.resolved_by,
      ]),
    ]);
    const last = page.at(-1);
    return {
      decisions: page.map((q) => ({
        ...q,
        ...webDecisionView(authored, q),
        category: q.category ?? "general",
      })),
      next_cursor:
        rows.length > limit && last
          ? encodeCursor(scope, [last.resolution.at, last.id])
          : null,
    };
  });
}
