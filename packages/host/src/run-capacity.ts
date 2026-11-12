import {
  type Assignment,
  DEFAULT_MAX_RUN_LIMIT,
  DEFAULT_RUN_LIMIT,
  type Event,
  isStandingPm,
  occupiedRunSlots,
  pendingHostOpsActions,
  type QueuedRun,
  type Run,
  runQueuePositions,
} from "@cardigan/domain";
import {
  type ReadRepositories,
  readRunLimit,
  type Store,
  unfinishedBellAttempts,
} from "@cardigan/store";

import { runningMergeChecks } from "./merge-check-capacity.js";
import { LOCAL_EXECUTOR } from "./merge-gate-executors.js";

// P2a-9 / phase-2 §2.1: merge checks build and test the entire repository.
// Reserve the suggested two slots while actually running; tune after measurement.
export const MERGE_CHECK_RUN_SLOTS = 2;

/** Legacy/default local assignments can exist before a Machine row is registered. */
export function runCapacityMachines(
  store: Store,
  tx: ReadRepositories,
  displayName?: (machine: string) => string | undefined,
) {
  const machines = new Map<string, { id: string; label: string }>();
  for (const project of store.listProjects()) {
    for (const assignment of tx.assignments.list(project.id))
      if (!machines.has(assignment.machine_id))
        machines.set(assignment.machine_id, {
          id: assignment.machine_id,
          label: displayName?.(assignment.machine_id) ?? assignment.machine_id,
        });
  }
  for (const project of store.listProjects())
    for (const machine of tx.machines.list(project.id))
      machines.set(machine.id, { id: machine.id, label: machine.label });
  return [...machines.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function queueSnapshot(store: Store) {
  // Read only waiting rows, including their original trigger time. The stream
  // polls this projection, so do not load historical Runs/events on every poll.
  const rows = store.database
    .prepare(`SELECT r.project_id, r.doc AS run, a.doc AS owner,
      e.doc AS cause, w.card_id, json_extract(c.doc, '$.priority') AS priority FROM runs r
    JOIN assignments a ON a.project_id = r.project_id AND a.id = r.assignment_id
    JOIN events e ON e.project_id = r.project_id AND e.id = r.trigger_event_id
    LEFT JOIN work_items w ON w.project_id = a.project_id AND w.id = json_extract(a.doc, '$.work_item_id')
    LEFT JOIN cards c ON c.project_id = w.project_id AND c.id = w.card_id
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
      priority: Number(row.priority ?? 0),
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
    const actions = pendingHostOpsActions(
      [undefined, ...tx.cards.list(project.id).map((card) => card.id)].flatMap(
        (card) => tx.events.listAfter(project.id, card, 0),
      ),
    );
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
          actions.filter(
            (action) =>
              owners.has(action.assignment_id) &&
              action.runtime_ref !== null &&
              occupiedRunSlots(
                assignments,
                runs.filter((r) => r.assignment_id === action.assignment_id),
                machine,
              ) === 0,
          ).length +
          launching,
      );
    }
  }
  // Runtime occupancy is independent of whether a card still accepts a merge
  // result. Dead process incarnations (including PID reuse) release on restart.
  // P2a-12 D: only checks executed locally consume the host's `local` Run
  // slots; a remote executor's checks are counted in its own bucket and never
  // in `occupied`, even if an agent machine happens to share its name.
  const agentOccupied = new Map(occupied);
  const mergeChecks = runningMergeChecks(store);
  occupied.set(
    LOCAL_EXECUTOR,
    (occupied.get(LOCAL_EXECUTOR) ?? 0) +
      (mergeChecks.get(LOCAL_EXECUTOR) ?? 0) * MERGE_CHECK_RUN_SLOTS,
  );
  return { occupied, agentOccupied, mergeChecks, queue: queueSnapshot(store) };
}

export function readRunQueue(store: Store, tx?: ReadRepositories) {
  return tx ? queueSnapshot(store) : store.uow.read(() => queueSnapshot(store));
}

/** YAML is the default; invalid trusted config still fails closed, even with an override. */
export function effectiveRunLimit(
  store: Store,
  machine: string,
  defaults: (machine: string) => number = () => DEFAULT_RUN_LIMIT,
  maximums: (machine: string) => number = () => DEFAULT_MAX_RUN_LIMIT,
): number {
  const fallback = defaults(machine);
  const maximum = maximums(machine);
  return fallback > 0 && Number.isSafeInteger(maximum) && maximum > 0
    ? Math.min(
        readRunLimit(store.database, machine)?.limit ?? fallback,
        maximum,
      )
    : 0;
}
