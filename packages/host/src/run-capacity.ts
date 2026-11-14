import {
  type AssignmentId,
  compareDispatchOrder,
  DEFAULT_MAX_RUN_LIMIT,
  DEFAULT_RUN_LIMIT,
  type Event,
  type HostOpsExecution,
  isRunCapacityExempt,
  pendingHostOpsActions,
  type QueuedRun,
  runOccupiesSlot,
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

/**
 * C-230: the capacity queue used to be a json_extract scan over every Run row,
 * re-run on every claim. It is now built from the transaction's Run,
 * Assignment, WorkItem and Card lists and reused while those lists are the very
 * same arrays. Store snapshot lists are immutable: a write (including one made
 * earlier in the same transaction) yields a new array, a rollback returns the
 * committed array again, and nothing mutates one in place (the same convention
 * C-221's `eventById`/`hasRunTarget` indexes rely on). A backend that returns a
 * fresh array per call only misses the cache. Unfinished BellAttempts are not
 * snapshotted, so they are re-read and filtered on every call.
 *
 * Rows match the former JOIN: queued for `concurrency_limit`, owner active and
 * not capacity exempt, trigger event present; the card is the owner's work item
 * card, else the trigger event's card, and priority comes from that card.
 */
type QueueKey = readonly unknown[];
const queueCache = new WeakMap<
  Store,
  { key: QueueKey; sorted: readonly QueuedRun[] }
>();
// Event rows are append-only, so a Run object's trigger event never changes.
// Only hits are cached; a rolled-back Run object is never listed again.
const triggerEvents = new WeakMap<object, Event>();

function waitingRuns(store: Store, tx: ReadRepositories): readonly QueuedRun[] {
  const key: unknown[] = [];
  const projects = store.listProjects().map((project) => {
    const lists = {
      id: project.id,
      runs: tx.runs.list(project.id),
      assignments: tx.assignments.list(project.id),
      work_items: tx.work_items.list(project.id),
      cards: tx.cards.list(project.id),
    };
    key.push(
      lists.id,
      lists.runs,
      lists.assignments,
      lists.work_items,
      lists.cards,
    );
    return lists;
  });
  const cached = queueCache.get(store);
  if (
    cached?.key.length === key.length &&
    cached.key.every((value, i) => value === key[i])
  )
    return cached.sorted;
  const queue: QueuedRun[] = [];
  let triggerEvent: ReturnType<Store["database"]["prepare"]> | undefined;
  for (const project of projects) {
    const waiting = project.runs.filter(
      (r) => r.status === "queued" && r.queue_reason === "concurrency_limit",
    );
    if (waiting.length === 0) continue;
    const assignments = new Map(
      project.assignments.map((a) => [a.id, a] as const),
    );
    const items = new Map(project.work_items.map((w) => [w.id, w] as const));
    const cards = new Map(project.cards.map((c) => [c.id, c] as const));
    for (const run of waiting) {
      const owner = assignments.get(run.assignment_id);
      if (owner?.status !== "active" || isRunCapacityExempt(owner)) continue;
      let cause = triggerEvents.get(run);
      if (!cause) {
        triggerEvent ??= store.database.prepare(
          "SELECT doc FROM events WHERE project_id = ? AND id = ?",
        );
        const row = triggerEvent.get(project.id, run.trigger_event_id);
        if (!row) continue;
        cause = JSON.parse(String(row.doc)) as Event;
        triggerEvents.set(run, cause);
      }
      const workItem =
        "work_item_id" in owner && owner.work_item_id !== undefined
          ? items.get(owner.work_item_id)
          : undefined;
      const priority = workItem
        ? cards.get(workItem.card_id)?.priority
        : undefined;
      const card = workItem?.card_id ?? cause.card_id;
      queue.push({
        priority: Number(priority ?? 0),
        project_id: project.id,
        assignment_id: owner.id,
        machine_id: owner.machine_id,
        run_id: run.id,
        trigger_event_id: cause.id,
        created_at: cause.created_at,
        ...(card ? { card_id: String(card) } : {}),
      });
    }
  }
  const sorted = [...queue].sort(compareDispatchOrder);
  queueCache.set(store, { key, sorted });
  return sorted;
}

function queueSnapshot(
  store: Store,
  tx: ReadRepositories,
  reservedRuns?: ReadonlyMap<string, ReadonlySet<string>>,
) {
  const sorted = waitingRuns(store, tx);
  const reserved = new Map(reservedRuns);
  // Filtering a stably sorted list keeps the order `runQueuePositions` would
  // give the filtered rows, so its re-sort only confirms the order.
  return runQueuePositions(
    sorted.filter((entry) => {
      let runs = reserved.get(entry.project_id);
      if (!runs) {
        runs = new Set(
          unfinishedBellAttempts(store.database, entry.project_id).map(
            (a) => a.run_id,
          ),
        );
        reserved.set(entry.project_id, runs);
      }
      return !runs.has(entry.run_id);
    }),
  );
}

const pendingActions = new WeakMap<
  ReadonlyMap<string, readonly Event[]>,
  WeakMap<readonly object[], readonly HostOpsExecution[]>
>();

/** Read under the caller's transaction so counting and claiming share a snapshot. */
export function runCapacitySnapshot(store: Store, tx: ReadRepositories) {
  // Both views share the exact same effective Run/reservation set. Only the
  // trusted Assignment scope and role determine exemption, never Run labels.
  const agentOccupied = new Map<string, number>();
  const allAgentOccupied = new Map<string, number>();
  const reservedRuns = new Map<string, ReadonlySet<string>>();
  for (const project of store.listProjects()) {
    const assignments = tx.assignments.list(project.id);
    const runs = tx.runs.list(project.id);
    // C-216: reuse the Store's cached per-stream history when the transaction
    // offers it; otherwise re-read each stream. Same streams, same order.
    // C-230: with the cache, also reuse the result while the stream map and
    // card list are the same immutable snapshots (see `queueCache`).
    const streams = tx.events.listStreams?.(project.id);
    const cards = tx.cards.list(project.id);
    const collect = () =>
      pendingHostOpsActions(
        [undefined, ...cards.map((card) => card.id)].flatMap((card) =>
          streams
            ? (streams.get(card ?? "") ?? [])
            : tx.events.listAfter(project.id, card, 0),
        ),
      );
    let actions: readonly HostOpsExecution[];
    if (streams) {
      let byCards = pendingActions.get(streams);
      if (!byCards) {
        byCards = new WeakMap();
        pendingActions.set(streams, byCards);
      }
      actions = byCards.get(cards) ?? collect();
      byCards.set(cards, actions);
    } else actions = collect();
    const reserved = new Set(
      unfinishedBellAttempts(store.database, project.id).map((a) => a.run_id),
    );
    reservedRuns.set(project.id, reserved);
    const owners = new Map(assignments.map((a) => [a.id, a]));
    const countedOwners = new Set<string>();
    for (const { machine_id } of assignments) {
      if (!agentOccupied.has(machine_id)) agentOccupied.set(machine_id, 0);
      if (!allAgentOccupied.has(machine_id))
        allAgentOccupied.set(machine_id, 0);
    }
    const count = (assignmentId: AssignmentId) => {
      const owner = owners.get(assignmentId);
      if (!owner) return;
      const machine = owner.machine_id;
      allAgentOccupied.set(machine, (allAgentOccupied.get(machine) ?? 0) + 1);
      if (!isRunCapacityExempt(owner))
        agentOccupied.set(machine, (agentOccupied.get(machine) ?? 0) + 1);
      countedOwners.add(owner.id);
    };
    for (const run of runs)
      if (
        runOccupiesSlot(run) ||
        (run.status === "queued" && reserved.has(run.id))
      )
        count(run.assignment_id);
    for (const action of actions)
      if (
        action.runtime_ref !== null &&
        !countedOwners.has(action.assignment_id)
      )
        count(action.assignment_id);
  }
  // Runtime occupancy is independent of whether a card still accepts a merge
  // result. Dead process incarnations (including PID reuse) release on restart.
  // P2a-12 D: only checks executed locally consume the host's `local` Run
  // slots; a remote executor's checks are counted in its own bucket and never
  // in `occupied`, even if an agent machine happens to share its name.
  const occupied = new Map(agentOccupied);
  const mergeChecks = runningMergeChecks(store);
  occupied.set(
    LOCAL_EXECUTOR,
    (occupied.get(LOCAL_EXECUTOR) ?? 0) +
      (mergeChecks.get(LOCAL_EXECUTOR) ?? 0) * MERGE_CHECK_RUN_SLOTS,
  );
  return {
    occupied,
    agentOccupied,
    allAgentOccupied,
    mergeChecks,
    queue: queueSnapshot(store, tx, reservedRuns),
  };
}

export function readRunQueue(store: Store, tx?: ReadRepositories) {
  return tx
    ? queueSnapshot(store, tx)
    : store.uow.read((read) => queueSnapshot(store, read));
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
