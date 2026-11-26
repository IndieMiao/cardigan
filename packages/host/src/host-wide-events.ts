import type { DatabaseSync } from "node:sqlite";

/**
 * C-793: probe and macOS check jobs are host-wide, but a bare
 * `WHERE type = ?` cannot use the `(project_id, type)` index and, without
 * planner statistics, scans the whole events table. The recursive CTE walks
 * the distinct `project_id` values of `events` itself (a loose index scan, one
 * seek per project) so the type lookup is bound per project; no project is
 * skipped even when it was never registered in `projects`.
 */
export const HOST_WIDE_EVENTS_SQL = `WITH RECURSIVE project(id) AS (
    SELECT min(project_id) FROM events
    UNION ALL
    SELECT (SELECT min(project_id) FROM events WHERE project_id > project.id)
    FROM project WHERE project.id IS NOT NULL
  )
  SELECT doc FROM events
  WHERE project_id IN (SELECT id FROM project WHERE id IS NOT NULL)
    AND type = ?
  ORDER BY seq`;

/** Documents of every `events` row of one type across all projects, in `seq` order. */
export function hostWideEventDocs<Payload>(
  db: DatabaseSync,
  type: string,
): { actor: { kind: string }; payload: Payload }[] {
  return db
    .prepare(HOST_WIDE_EVENTS_SQL)
    .all(type)
    .map((row) => JSON.parse(String(row.doc)));
}
