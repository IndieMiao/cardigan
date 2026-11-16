import type { SQLInputValue } from "node:sqlite";
import type { ProjectId } from "@cardigan/domain";
import type { Store } from "@cardigan/store";
import { HttpRejection } from "./http.js";
import { decodeCursor, encodeCursor, pageLimit } from "./pagination.js";
import {
  type ActivityQuery,
  activity,
  EVENT_CATEGORIES,
  RANGE_MS,
} from "./read.js";
import { emptyState, inIds, readDocs, withAuthors } from "./sql-state.js";

/** Filter and page event keys in SQLite before decoding any payloads. */
export function readActivity(
  store: Store,
  project: ProjectId,
  url: URL,
  now: string,
) {
  const params = url.searchParams;
  const limit = pageLimit(params.get("limit"), "activity");
  const filters = Object.fromEntries(
    ["card_id", "role", "actor", "type", "category", "range"].map((key) => [
      key,
      params.get(key) || "",
    ]),
  );
  const scope = JSON.stringify([project, "activity", filters]);
  const cursor = decodeCursor(params.get("before"), scope);
  if (
    cursor &&
    (cursor.length !== 3 ||
      typeof cursor[0] !== "string" ||
      typeof cursor[1] !== "string" ||
      !cursor[1] ||
      !Number.isFinite(Date.parse(String(cursor[0]))) ||
      typeof cursor[2] !== "string" ||
      (cursor[2] !== "" && !Number.isFinite(Date.parse(cursor[2]))))
  )
    throw new HttpRejection(400, "validation_failed", "活动游标无效");
  let since = cursor?.[2] as string | undefined;
  const where = ["project_id = ?"];
  const args: SQLInputValue[] = [project];
  if (filters.card_id) {
    where.push("card_id = ?");
    args.push(filters.card_id);
  }
  if (filters.type) {
    where.push("type = ?");
    args.push(filters.type);
  } else {
    // Read audit stays queryable, but must not crowd out project activity.
    where.push("type <> 'cross_card_read'");
  }
  const role =
    "CASE WHEN json_extract(doc, '$.actor.kind') = 'assignment' THEN json_extract(doc, '$.actor.role_id') ELSE json_extract(doc, '$.actor.kind') END";
  if (filters.role) {
    where.push(`${role} = ?`);
    args.push(filters.role);
  }
  if (filters.actor) {
    if (!["human", "system", "pm", "agent"].includes(filters.actor))
      throw new HttpRejection(400, "validation_failed", "发言方筛选无效");
    where.push(
      `CASE WHEN (${role}) IN ('pm','office','ops') THEN 'pm' WHEN (${role}) IN ('human','system') THEN (${role}) ELSE 'agent' END = ?`,
    );
    args.push(filters.actor);
  }
  if (filters.category) {
    const types = EVENT_CATEGORIES[filters.category];
    if (!types && filters.category !== "other")
      throw new HttpRejection(400, "validation_failed", "事件类别无效");
    where.push(
      `type ${types ? "IN" : "NOT IN"} (SELECT value FROM json_each(?))`,
    );
    args.push(JSON.stringify(types ?? Object.values(EVENT_CATEGORIES).flat()));
  }
  if (filters.range) {
    const range = RANGE_MS[filters.range];
    if (!range)
      throw new HttpRejection(400, "validation_failed", "时间范围无效");
    where.push("json_extract(doc, '$.created_at') >= ?");
    since ??= new Date(Date.parse(now) - range).toISOString();
    args.push(since);
  }
  if (cursor) {
    where.push("(json_extract(doc, '$.created_at'), id) < (?, ?)");
    args.push(cursor[0] as string, cursor[1] as string);
  }
  return store.uow.read((tx) => {
    const predicate = where.join(" AND ");
    const rows = store.database
      .prepare(
        `SELECT doc FROM events WHERE ${predicate} ORDER BY json_extract(doc, '$.created_at') DESC, id DESC LIMIT ?`,
      )
      .all(...args, limit + 1)
      .map((row) => JSON.parse(String(row.doc))) as ReturnType<
      typeof emptyState
    >["events"];
    const page = rows.slice(0, limit);
    const base = emptyState(tx, project);
    const state = withAuthors(
      store,
      {
        ...base,
        events: page,
        cards: readDocs(store, project, "cards", inIds("id"), [
          JSON.stringify(page.map((e) => e.card_id)),
        ]),
      },
      page.map((e) =>
        e.actor.kind === "assignment"
          ? `assignment:${e.actor.assignment_id}`
          : e.actor.kind,
      ),
    );
    const result = activity(
      state,
      {
        limit,
        ...(filters.type ? { type: filters.type } : {}),
      } as ActivityQuery,
      now,
    );
    const last = page.at(-1);
    return {
      ...result,
      events: page.flatMap((e) => {
        const view = result.events.find((v) => v.id === e.id);
        return view ? [view] : [];
      }),
      counts: {
        returned: page.length,
        matched: Number(
          store.database
            .prepare(`SELECT COUNT(*) AS n FROM events WHERE ${predicate}`)
            .get(...args)?.n ?? 0,
        ),
      },
      next_before:
        rows.length > limit && last
          ? encodeCursor(scope, [last.created_at, last.id, since ?? ""])
          : null,
      // Filter choices are scalar metadata, never full card bodies or histories.
      cards: store.database
        .prepare(
          "SELECT id, json_extract(doc, '$.title') AS title FROM cards WHERE project_id = ? ORDER BY CAST(substr(id, 3) AS INTEGER)",
        )
        .all(project),
    };
  });
}
