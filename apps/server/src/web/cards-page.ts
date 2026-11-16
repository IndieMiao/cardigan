import type { SQLInputValue } from "node:sqlite";
import type { ProjectId } from "@cardigan/domain";
import type { ReadRepositories, Store } from "@cardigan/store";
import { cardSelectors } from "./card-selectors.js";
import { HttpRejection } from "./http.js";
import {
  decodeCursor,
  encodeCursor,
  pageLimit,
  READ_LIMITS,
} from "./pagination.js";
import { readWorkbenchQueue } from "./queue-state.js";
import { type CardListView, cardListViews, parseCardFilter } from "./read.js";
import { inIds, scopedCardState } from "./sql-state.js";

const statuses = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "awaiting_merge",
  "done",
  "cancelled",
];
export function readCardsPage(
  store: Store,
  project: ProjectId,
  url: URL,
  transaction?: ReadRepositories,
) {
  const params = url.searchParams;
  const filter = parseCardFilter(params.get("filter"));
  const board = params.get("mode") === "board";
  const limit = pageLimit(params.get("limit"), board ? "board" : "cards");
  const sort = params.get("sort") || "id";
  if (!["id", "priority", "updated"].includes(sort))
    throw new HttpRejection(400, "validation_failed", "卡片排序无效");
  const selectedStatuses = (params.get("status") || "")
    .split(",")
    .filter(Boolean);
  if (selectedStatuses.some((s) => !statuses.includes(s)))
    throw new HttpRejection(400, "validation_failed", "卡片状态无效");
  const requestedPage = Number(params.get("page") || 1);
  if (!Number.isSafeInteger(requestedPage) || requestedPage < 1)
    throw new HttpRejection(400, "validation_failed", "页码无效");
  const makeScope = (laneStatuses: string[]) =>
    JSON.stringify([
      project,
      "cards",
      filter,
      sort,
      laneStatuses,
      params.get("q") || "",
      params.get("role") || "",
      params.get("next") || "",
      params.get("overview") || "",
    ]);
  const scope = makeScope(selectedStatuses);
  const cursor = decodeCursor(params.get("cursor"), scope);
  if (cursor && (cursor.length !== 2 || typeof cursor[1] !== "number"))
    throw new HttpRejection(400, "validation_failed", "卡片游标无效");
  const read = (tx: ReadRepositories) => {
    const active = cardSelectors(tx, project);
    const derived = JSON.stringify(active);
    // TEXT affinity lets SQLite index this materialized lookup instead of scanning
    // every derived row for every card (including each board lane).
    const withDerived = `WITH derived AS MATERIALIZED (
      SELECT CAST(json_extract(value, '$.id') AS TEXT) AS id, value FROM json_each(?)
    ) `;
    const fromCards = "cards c LEFT JOIN derived ON derived.id = c.id";
    const effectiveStatus =
      "COALESCE(json_extract(derived.value, '$.status'), json_extract(c.doc, '$.status'))";
    const queue = readWorkbenchQueue(store, tx);
    const where = ["c.project_id = ?"];
    const args: SQLInputValue[] = [project];
    if (selectedStatuses.length) {
      where.push(inIds(effectiveStatus));
      args.push(JSON.stringify(selectedStatuses));
    }
    const q = (params.get("q") || "").trim().toLowerCase();
    if (q) {
      where.push(
        "instr(lower(c.id || ' ' || json_extract(c.doc, '$.title')), ?) > 0",
      );
      args.push(q);
    }
    const role = params.get("role");
    if (role) {
      where.push(
        "EXISTS (SELECT 1 FROM work_items w WHERE w.project_id = c.project_id AND w.card_id = c.id AND json_extract(w.doc, '$.role_id') = ?)",
      );
      args.push(role);
    }
    const next = params.get("next") || "";
    const overview = params.get("overview") || "";
    if (
      (next && !["human", "agent", "none"].includes(next)) ||
      (overview &&
        !["human", "agent", "progress", "review", "blocked"].includes(overview))
    )
      throw new HttpRejection(400, "validation_failed", "卡片筛选条件无效");
    if (filter !== "all" || next || overview) {
      const eligible = active.filter(
        (c) =>
          (filter === "all" ||
            (filter === "needs_me" ? Boolean(c.needs_me) : Boolean(c.agent))) &&
          (!next ||
            (c.human ? "human" : c.agent ? "agent" : "none") === next) &&
          (!overview ||
            (overview === "human"
              ? Boolean(c.human)
              : overview === "agent"
                ? Boolean(c.agent)
                : overview === "progress"
                  ? c.status === "in_progress"
                  : overview === "review"
                    ? ["review", "awaiting_merge"].includes(c.status)
                    : Boolean(c.blocked))),
      );
      where.push(
        `(${inIds("c.id")}${filter === "all" && next === "none" && !overview ? " OR json_extract(c.doc, '$.status') IN ('done','cancelled')" : ""})`,
      );
      args.push(JSON.stringify(eligible.map((c) => c.id)));
    }
    const updated =
      "COALESCE((SELECT MAX(json_extract(e.doc, '$.created_at')) FROM events e WHERE e.project_id = c.project_id AND e.card_id = c.id), json_extract(c.doc, '$.created_at'))";
    const numericId = "CAST(substr(c.id, 3) AS INTEGER)";
    const key =
      sort === "id"
        ? numericId
        : sort === "priority"
          ? "json_extract(c.doc, '$.priority')"
          : updated;
    const order =
      sort === "id"
        ? `${key} ASC`
        : sort === "priority"
          ? `${key} DESC, ${numericId} ASC`
          : `${key} DESC, ${numericId} DESC`;
    const countRow = store.database
      .prepare(`${withDerived}SELECT count(*) AS total,
      COALESCE(sum(json_extract(derived.value, '$.needs_me')), 0) AS needs_me,
      COALESCE(sum(json_extract(derived.value, '$.agent')), 0) AS agent
      FROM ${fromCards} WHERE c.project_id = ?`)
      .get(derived, project);
    const counts = {
      total: Number(countRow?.total ?? 0),
      needs_me: Number(countRow?.needs_me ?? 0),
      agent: Number(countRow?.agent ?? 0),
    };
    const predicate = where.join(" AND ");
    const totals = store.database
      .prepare(
        `${withDerived}SELECT ${effectiveStatus} AS status, count(*) AS n FROM ${fromCards} WHERE ${predicate} GROUP BY ${effectiveStatus}`,
      )
      .all(derived, ...args);
    const total = totals.reduce((n, r) => n + Number(r.n), 0);
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / limit)));
    const lanes: Record<string, { total: number; next_cursor: string | null }> =
      {};
    const selected: {
      id: string;
      updated_at: string;
      key: string | number;
      number: number;
    }[] = [];
    const requestedIds = params.get("ids")?.split(",").filter(Boolean);
    if (requestedIds && requestedIds.length > READ_LIMITS.changedCards)
      throw new HttpRejection(
        400,
        "validation_failed",
        "变化卡片过多，请刷新当前页",
      );
    const load = (lane?: string) => {
      const conditions = [...where];
      const bound = [...args];
      if (lane) {
        conditions.push(`${effectiveStatus} = ?`);
        bound.push(lane);
      }
      if (requestedIds) {
        conditions.push(inIds("c.id"));
        bound.push(JSON.stringify(requestedIds));
      }
      if (cursor) {
        if (sort === "id") {
          conditions.push(`${numericId} > ?`);
          bound.push(cursor[1] as number);
        } else {
          conditions.push(
            `(${key} < ? OR (${key} = ? AND ${numericId} ${sort === "priority" ? ">" : "<"} ?))`,
          );
          bound.push(
            cursor[0] as SQLInputValue,
            cursor[0] as SQLInputValue,
            cursor[1] as number,
          );
        }
      }
      const rows = store.database
        .prepare(
          `${withDerived}SELECT c.id, ${updated} AS updated_at, ${key} AS key, ${numericId} AS number FROM ${fromCards} WHERE ${conditions.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
        )
        .all(
          derived,
          ...bound,
          requestedIds ? READ_LIMITS.changedCards : limit + 1,
          board || cursor || requestedIds ? 0 : (page - 1) * limit,
        ) as typeof selected;
      const visible = requestedIds ? rows : rows.slice(0, limit);
      selected.push(...visible);
      const last = visible.at(-1);
      if (lane)
        lanes[lane] = {
          total: Number(totals.find((r) => r.status === lane)?.n ?? 0),
          next_cursor:
            rows.length > limit && last
              ? encodeCursor(makeScope([lane]), [last.key, last.number])
              : null,
        };
    };
    if (board)
      for (const lane of selectedStatuses.length ? selectedStatuses : statuses)
        load(lane);
    else load();
    const ids = selected.map((r) => r.id);
    let state = scopedCardState(store, tx, project, ids);
    const timestamps = new Map(selected.map((r) => [r.id, r.updated_at]));
    // Legacy timeline attachments need their entry solely to establish ownership.
    const legacy = state.attachments.flatMap((a) =>
      !a.card_id && a.attach_to.kind === "timeline_entry"
        ? [a.attach_to.id]
        : [],
    );
    if (legacy.length)
      state = {
        ...state,
        timeline: store.database
          .prepare(
            `SELECT doc FROM timeline WHERE project_id = ? AND ${inIds("id")}`,
          )
          .all(project, JSON.stringify(legacy))
          .map((r) => JSON.parse(String(r.doc))),
      };
    const views = new Map<string, CardListView>(
      cardListViews(state, timestamps, queue).map((c) => [c.id, c]),
    );
    const cards = ids.flatMap((id) => {
      const c = views.get(id);
      return c ? [c] : [];
    });
    return {
      project_id: project,
      filter,
      counts,
      cards:
        params.get("view") === "summary"
          ? cards.map(
              ({
                goal,
                acceptance_criteria,
                source,
                out_of_scope,
                ...summary
              }) => summary,
            )
          : cards,
      server_filtered: true,
      total_filtered: total,
      page,
      page_size: limit,
      lanes,
      roles: store.database
        .prepare(
          "SELECT DISTINCT json_extract(doc, '$.role_id') AS role FROM work_items WHERE project_id = ? ORDER BY role",
        )
        .all(project)
        .map((r) => String(r.role)),
    };
  };
  return transaction ? read(transaction) : store.uow.read(read);
}
