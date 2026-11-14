import {
  type ProjectId,
  type QueuedRun,
  runQueuePositions,
} from "@cardigan/domain";
import { type Store, unfinishedBellAttempts } from "@cardigan/store";

/** Same dispatch ordering as the host, with only queued rows crossing into JS. */
export function readWorkbenchQueue(store: Store) {
  const rows = store.database
    .prepare(`SELECT r.project_id, r.id AS run_id, r.assignment_id,
    a.machine_id, r.trigger_event_id, json_extract(e.doc, '$.created_at') AS created_at,
    COALESCE(w.card_id, e.card_id) AS card_id, COALESCE(json_extract(c.doc, '$.priority'), 0) AS priority
    FROM runs r JOIN projects p ON p.id = r.project_id
    JOIN assignments a ON a.project_id = r.project_id AND a.id = r.assignment_id
    JOIN events e ON e.project_id = r.project_id AND e.id = r.trigger_event_id
    LEFT JOIN work_items w ON w.project_id = r.project_id AND w.id = json_extract(a.doc, '$.work_item_id')
    LEFT JOIN cards c ON c.project_id = w.project_id AND c.id = w.card_id
    WHERE json_extract(r.doc, '$.status') = 'queued' AND json_extract(r.doc, '$.queue_reason') = 'concurrency_limit'
      AND json_extract(a.doc, '$.status') = 'active'
      AND NOT (json_extract(a.doc, '$.scope') = 'standing' AND json_extract(a.doc, '$.role_id') = 'pm')`)
    .all();
  const reserved = new Map<string, Set<string>>();
  for (const row of rows) {
    const project = String(row.project_id);
    if (!reserved.has(project))
      reserved.set(
        project,
        new Set(
          unfinishedBellAttempts(store.database, project as ProjectId).map(
            (a) => a.run_id,
          ),
        ),
      );
  }
  return runQueuePositions(
    rows
      .filter((r) => !reserved.get(String(r.project_id))?.has(String(r.run_id)))
      .map(
        (r) =>
          ({
            project_id: String(r.project_id),
            run_id: String(r.run_id),
            assignment_id: String(r.assignment_id),
            machine_id: String(r.machine_id),
            trigger_event_id: String(r.trigger_event_id),
            created_at: String(r.created_at),
            priority: Number(r.priority),
            ...(r.card_id ? { card_id: String(r.card_id) } : {}),
          }) as QueuedRun,
      ),
  );
}
