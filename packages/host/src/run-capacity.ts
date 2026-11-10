import {
  type Assignment,
  type Event,
  isStandingPm,
  occupiedRunSlots,
  type QueuedRun,
  type Run,
  runQueuePositions,
} from "@cardigan/domain";
import {
  type ReadRepositories,
  type Store,
  unfinishedBellAttempts,
} from "@cardigan/store";

// P2a-9 / phase-2 §2.1: merge checks build and test the entire repository.
// Reserve the suggested two slots while actually running; tune after measurement.
export const MERGE_CHECK_RUN_SLOTS = 2;

function queueSnapshot(store: Store) {
  // Read only waiting rows, including their original trigger time. The stream
  // polls this projection, so do not load historical Runs/events on every poll.
  const rows = store.database
    .prepare(`SELECT r.project_id, r.doc AS run, a.doc AS owner,
      e.doc AS cause, w.card_id FROM runs r
    JOIN assignments a ON a.project_id = r.project_id AND a.id = r.assignment_id
    JOIN events e ON e.project_id = r.project_id AND e.id = r.trigger_event_id
    LEFT JOIN work_items w ON w.project_id = a.project_id AND w.id = json_extract(a.doc, '$.work_item_id')
    WHERE json_extract(r.doc, '$.status') = 'queued' AND json_extract(r.doc, '$.queue_reason') = 'concurrency_limit'
      AND json_extract(a.doc, '$.status') = 'active' AND NOT EXISTS (
        SELECT 1 FROM bell_attempts b WHERE b.project_id = r.project_id AND b.run_id = r.id AND b.finished_at IS NULL
      )`)
    .all();
  const queue: QueuedRun[] = [];
  for (const row of rows) {
    const owner = JSON.parse(String(row.owner)) as Assignment;
    if (isStandingPm(owner)) continue;
    const run = JSON.parse(String(row.run)) as Run;
    const cause = JSON.parse(String(row.cause)) as Event;
    const card = row.card_id ?? cause.card_id;
    queue.push({
      project_id: String(row.project_id),
      assignment_id: owner.id,
      machine_id: owner.machine_id,
      run_id: run.id,
      trigger_event_id: cause.id,
      created_at: cause.created_at,
      ...(card ? { card_id: String(card) } : {}),
    });
  }
  return runQueuePositions(queue);
}

/** Read under the caller's transaction so counting and claiming share a snapshot. */
export function runCapacitySnapshot(store: Store, tx: ReadRepositories) {
  const occupied = new Map<string, number>();
  for (const project of store.listProjects()) {
    const assignments = tx.assignments.list(project.id);
    const runs = tx.runs.list(project.id);
    const reserved = new Set(
      unfinishedBellAttempts(store.database, project.id).map((a) => a.run_id),
    );
    for (const machine of new Set(assignments.map((a) => a.machine_id))) {
      const owners = new Set(
        assignments.filter((a) => a.machine_id === machine).map((a) => a.id),
      );
      const launching = runs.filter(
        (r) =>
          r.status === "queued" &&
          owners.has(r.assignment_id) &&
          reserved.has(r.id),
      ).length;
      occupied.set(
        machine,
        (occupied.get(machine) ?? 0) +
          occupiedRunSlots(assignments, runs, machine) +
          launching,
      );
    }
  }
  // P2a has only the local execution machine. Count attempts even when their
  // completion was superseded: checks keep occupying CPU until they finish.
  const checks = store.database
    .prepare(`SELECT COUNT(*) AS count FROM events AS started
    WHERE started.type = 'merge_check_started' AND NOT EXISTS (
      SELECT 1 FROM events AS finished WHERE finished.project_id = started.project_id
      AND finished.type = 'merge_check_finished'
      AND json_extract(finished.doc, '$.payload.attempt_id') = json_extract(started.doc, '$.payload.attempt_id')
    )`)
    .get();
  occupied.set(
    "local",
    (occupied.get("local") ?? 0) +
      Number(checks?.count ?? 0) * MERGE_CHECK_RUN_SLOTS,
  );
  return { occupied, queue: queueSnapshot(store) };
}

export function readRunQueue(store: Store, tx?: ReadRepositories) {
  return tx ? queueSnapshot(store) : store.uow.read(() => queueSnapshot(store));
}
