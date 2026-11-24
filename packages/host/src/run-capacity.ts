import {
  type Assignment,
  type AssignmentId,
  assignmentDependenciesAllowStart,
  cardDependencyDispatchOrder,
  compareDispatchOrder,
  DEFAULT_MAX_RUN_LIMIT,
  DEFAULT_RUN_LIMIT,
  type DispatchOrder,
  dispatchTier,
  type Event,
  type HostOpsExecution,
  hostOpsPending,
  isRunCapacityExempt,
  type MachineResources,
  type MachineRunCapacity,
  pendingHostOpsActions,
  type QueuedRun,
  type Run,
  remainingResourceRatio,
  runEndedByBusiness,
  runHoldsCapacity,
  runOccupiesSlot,
  runQueuePositions,
  stoppedByHuman,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  type ReadRepositories,
  readRunLimit,
  type Store,
  unfinishedBellAttempts,
} from "@cardigan/store";
import { runningMergeChecks } from "./merge-check-capacity.js";
import { LOCAL_EXECUTOR } from "./merge-gate-executors.js";
import type { ReadProjectQuota } from "./project-quotas.js";
import {
  assignmentResourceKeys,
  legacyResourceKeys,
  wasDispatched,
} from "./run-resources.js";

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
 * Assignment, WorkItem, Card and Delivery lists plus event streams, and reused
 * while those immutable snapshots are unchanged. Store snapshot lists are immutable: a write (including one made
 * earlier in the same transaction) yields a new array, a rollback returns the
 * committed array again, and nothing mutates one in place (the same convention
 * C-221's `eventById`/`hasRunTarget` indexes rely on). A backend that returns a
 * fresh array per call only misses the cache. Unfinished BellAttempts are not
 * snapshotted, so they are re-read and filtered on every call.
 *
 * Rows match the former JOIN: queued for `concurrency_limit`, owner active,
 * not capacity exempt and not stopped by the human, trigger event present; the card is the owner's work item
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
      card_templates: tx.card_templates.list(project.id),
      deliveries: tx.deliveries.list(project.id),
      // C-639: in hot scope reuse the hot command history (same rule inputs).
      events:
        tx.command_state_scope !== "full" &&
        tx.command_state_scope !== undefined &&
        tx.events.listStreams
          ? loadCommandState(tx, project.id).events
          : tx.events.listStreams?.(project.id),
    };
    key.push(
      lists.id,
      lists.runs,
      lists.assignments,
      lists.work_items,
      lists.cards,
      lists.card_templates,
      lists.deliveries,
      ...(lists.events
        ? [lists.events]
        : [undefined, ...lists.cards.map((c) => c.id)].map((card) =>
            tx.events.listAfter(project.id, card, 0),
          )),
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
    const history = project.events
      ? Array.isArray(project.events)
        ? (project.events as readonly Event[])
        : [
            ...(
              project.events as ReadonlyMap<string, readonly Event[]>
            ).values(),
          ].flat()
      : [undefined, ...project.cards.map((c) => c.id)].flatMap((card) =>
          tx.events.listAfter(project.id, card, 0),
        );
    const dependencyState = { ...project, events: history };
    for (const run of waiting) {
      const owner = assignments.get(run.assignment_id);
      if (owner?.status !== "active" || isRunCapacityExempt(owner)) continue;
      if (!assignmentDependenciesAllowStart(dependencyState, owner)) continue;
      // C-624: nobody dispatches a human-stopped owner, so it cannot hold a
      // queue position ahead of others. A human start restores its place.
      if (stoppedByHuman(history, owner.id)) continue;
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
      if (workItem && cards.get(workItem.card_id)?.hold) continue;
      const priority = workItem
        ? cards.get(workItem.card_id)?.priority
        : undefined;
      const card = workItem?.card_id ?? cause.card_id;
      if (card && cards.get(card)?.hold) continue;
      queue.push({
        ...dispatchTier(
          { ...project, project_id: project.id, events: history },
          owner,
          run,
          cause,
        ),
        priority: Number(priority ?? 0),
        ...cardDependencyDispatchOrder(dependencyState, owner),
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
  object,
  WeakMap<readonly object[], readonly HostOpsExecution[]>
>();

// Project + card stream per immutable snapshot pair, so the domain's per-array
// memos (hostOpsPending, stoppedByHuman) are reused across claims.
const ownerHistories = new WeakMap<
  readonly Event[],
  WeakMap<readonly Event[], readonly Event[]>
>();
function ownerHistory(
  tx: ReadRepositories,
  project: string,
  owner: Assignment,
): readonly Event[] {
  const card =
    owner.work_item_id &&
    tx.work_items.get(project, owner.work_item_id)?.card_id;
  const streams = tx.events.listStreams?.(project);
  if (!streams)
    return [
      ...tx.events.listAfter(project, undefined, 0),
      ...(card ? tx.events.listAfter(project, card, 0) : []),
    ];
  const base = streams.get("") ?? [];
  const own = (card && streams.get(card)) || [];
  let byCard = ownerHistories.get(base);
  if (!byCard) {
    byCard = new WeakMap();
    ownerHistories.set(base, byCard);
  }
  let merged = byCard.get(own);
  if (!merged) {
    merged = [...base, ...own];
    byCard.set(own, merged);
  }
  return merged;
}

/**
 * C-620: an earlier waiter whose owner cannot start any session now (pending
 * host operation, unconfirmed recycle, human stop, role upgrade, or another
 * Run still active) is not runnable and must not hold the queue behind it.
 * It regains its place as soon as the fence clears.
 */
function ownerFenced(
  tx: ReadRepositories,
  project: string,
  owner: Assignment,
  run: string,
): boolean {
  if (
    owner.role_upgrade ||
    owner.idle_retirement?.handoff ||
    owner.idle_retirement?.phase === "stopping"
  )
    return true;
  if (
    tx.runs
      .list(project)
      .some(
        (r) =>
          r.assignment_id === owner.id &&
          r.id !== run &&
          r.status !== "queued" &&
          runOccupiesSlot(r),
      )
  )
    return true;
  const events = ownerHistory(tx, project, owner);
  return hostOpsPending(events, owner.id) || stoppedByHuman(events, owner.id);
}

/**
 * Keep the existing order among runnable waiters, without blocking other resources.
 * C-721: `keysFor` names the resources a waiter's Run would claim; by default
 * its work item's, so a waiter that may need fewer is judged conservatively.
 */
export function hasEarlierCapacityWait(
  tx: ReadRepositories,
  queue: readonly QueuedRun[],
  order: DispatchOrder,
  machine: string,
  resources: MachineResources,
  now: string,
  eligible?: (
    project: string,
    owner: Assignment,
    keys: readonly string[],
  ) => boolean,
  preferredProject?: string,
  keysFor: (entry: QueuedRun, owner: Assignment) => readonly string[] = (
    entry,
    owner,
  ) => assignmentResourceKeys(tx, entry.project_id, owner),
): boolean {
  return queue.some((entry) => {
    const priority =
      Number(order.project_id === preferredProject) -
      Number(entry.project_id === preferredProject);
    if (
      entry.machine_id !== machine ||
      (priority || compareDispatchOrder(entry, order)) >= 0
    )
      return false;
    const owner = tx.assignments
      .list(entry.project_id)
      .find((a) => a.id === entry.assignment_id);
    if (
      !owner ||
      (owner.snapshot_retry && owner.snapshot_retry.ready_at > now) ||
      ownerFenced(tx, entry.project_id, owner, entry.run_id)
    )
      return false;
    const keys = keysFor(entry, owner);
    return (
      (!eligible || eligible(entry.project_id, owner, keys)) &&
      (!resources.size || remainingResourceRatio(keys, resources) > 0)
    );
  });
}

export type ReadResourceLimits = (
  machine: string,
) => ReadonlyMap<string, number>;

/**
 * C-714: diagnosis only. Names the full ceiling that keeps an owner waiting
 * although its machine still has Run slots, with the Runs holding it. Mirrors
 * `withinProjectQuota` and `remainingResourceRatio`; admission never reads it.
 */
export type RunCapacityBlock =
  | {
      readonly kind: "project_limit";
      readonly project_id: string;
      readonly machine_id: string;
      readonly limit: number;
      readonly run_ids: readonly string[];
    }
  | {
      readonly kind: "project_resource";
      readonly project_id: string;
      readonly machine_id: string;
      readonly resource: string;
      readonly limit: number;
      readonly run_ids: readonly string[];
    }
  | {
      readonly kind: "machine_resource";
      readonly machine_id: string;
      readonly resource: string;
      readonly limit: number;
      /** Only the asking project's Runs; other projects are a bare count. */
      readonly run_ids: readonly string[];
      readonly other_project_runs: number;
    };

/** Read under the caller's transaction so counting and claiming share a snapshot. */
export function runCapacitySnapshot(
  store: Store,
  tx: ReadRepositories,
  limits?: ReadResourceLimits,
  quotas?: ReadProjectQuota,
) {
  const machines = new Map<
    string,
    Map<string, { limit: number; occupied: number }>
  >();
  // C-714: which Runs hold each machine resource slot (diagnosis only).
  const slotRuns = new Map<
    string,
    Map<string, { project: string; run: string }[]>
  >();
  const holders = <T>(byKey: Map<string, T[]>, key: string) => {
    let runs = byKey.get(key);
    if (!runs) {
      runs = [];
      byKey.set(key, runs);
    }
    return runs;
  };
  const resourceSlots = (machine: string) => {
    let slots = machines.get(machine);
    if (!slots) {
      slots = new Map();
      for (const [key, limit] of limits?.(machine) ?? [])
        slots.set(key, { limit, occupied: 0 });
      machines.set(machine, slots);
    }
    return slots;
  };
  // Both views share the exact same effective Run/reservation set. Only the
  // trusted Assignment scope and role determine exemption, never Run labels.
  type Usage = {
    occupied: number;
    resources: Map<string, number>;
    runs: string[];
    resourceRuns: Map<string, string[]>;
  };
  const projectUsage = new Map<string, Map<string, Usage>>();
  const agentOccupied = new Map<string, number>();
  const allAgentOccupied = new Map<string, number>();
  const reservedRuns = new Map<string, ReadonlySet<string>>();
  const occupiedOwners = new Map<string, ReadonlySet<string>>();
  for (const project of store.listProjects()) {
    const assignments = tx.assignments.list(project.id);
    const runs = tx.runs.list(project.id);
    // C-216: reuse the Store's cached per-stream history when the transaction
    // offers it; otherwise re-read each stream. Same streams, same order.
    // C-230: with the cache, also reuse the result while the stream map and
    // card list are the same immutable snapshots (see `queueCache`).
    const hot =
      tx.command_state_scope !== "full" &&
      tx.command_state_scope !== undefined &&
      tx.events.listStreams
        ? loadCommandState(tx, project.id).events
        : undefined;
    const streams = tx.events.listStreams?.(project.id);
    const cards = tx.cards.list(project.id);
    // Host actions and their finishes are never cold-omitted types (C-639).
    const collect = () =>
      pendingHostOpsActions(
        hot ??
          [undefined, ...cards.map((card) => card.id)].flatMap((card) =>
            streams
              ? (streams.get(card ?? "") ?? [])
              : tx.events.listAfter(project.id, card, 0),
          ),
      );
    let actions: readonly HostOpsExecution[];
    const cacheKey = hot ?? streams;
    if (cacheKey) {
      let byCards = pendingActions.get(cacheKey);
      if (!byCards) {
        byCards = new WeakMap();
        pendingActions.set(cacheKey, byCards);
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
    occupiedOwners.set(project.id, countedOwners);
    for (const { machine_id } of assignments) {
      if (!agentOccupied.has(machine_id)) agentOccupied.set(machine_id, 0);
      if (!allAgentOccupied.has(machine_id))
        allAgentOccupied.set(machine_id, 0);
    }
    const historyFor = (owner: Assignment) => {
      const card =
        owner.work_item_id &&
        tx.work_items.get(project.id, owner.work_item_id)?.card_id;
      return (
        streams?.get(card ?? "") ?? tx.events.listAfter(project.id, card, 0)
      );
    };
    const usageByMachine = new Map<string, Usage>();
    projectUsage.set(project.id, usageByMachine);
    const count = (assignmentId: AssignmentId, run?: Run, stopOnly = false) => {
      const owner = owners.get(assignmentId);
      if (!owner) return;
      const machine = owner.machine_id;
      allAgentOccupied.set(machine, (allAgentOccupied.get(machine) ?? 0) + 1);
      if (!isRunCapacityExempt(owner))
        agentOccupied.set(machine, (agentOccupied.get(machine) ?? 0) + 1);
      let usage = usageByMachine.get(machine);
      if (!usage && quotas?.(machine, project.id)) {
        usage = {
          occupied: 0,
          resources: new Map(),
          runs: [],
          resourceRuns: new Map(),
        };
        usageByMachine.set(machine, usage);
      }
      if (usage && !isRunCapacityExempt(owner)) {
        usage.occupied++;
        if (run) usage.runs.push(run.id);
      }
      const slots = resourceSlots(machine);
      // A pending stop of a possibly executing session keeps its machine slot.
      // An idle terminal is not proof that its queued follow-up acquired any
      // resources. Active Runs and in-flight startup reservations have already
      // been counted in the Run loop.
      if (
        slots.size &&
        owner.work_item_id &&
        run &&
        (!stopOnly || wasDispatched(historyFor(owner), run))
      ) {
        for (const key of run.resource_keys ??
          legacyResourceKeys(
            tx,
            project.id,
            owner,
            run,
            historyFor(owner),
            slots.keys(),
          )) {
          const slot = slots.get(key);
          if (slot) {
            slot.occupied++;
            usage?.resources.set(key, (usage.resources.get(key) ?? 0) + 1);
            let byKey = slotRuns.get(machine);
            if (!byKey) {
              byKey = new Map();
              slotRuns.set(machine, byKey);
            }
            holders(byKey, key).push({ project: project.id, run: run.id });
            if (usage) holders(usage.resourceRuns, key).push(run.id);
          }
        }
      }
      countedOwners.add(owner.id);
    };
    // C-620: an ended turn leaves an idle session. It holds no machine,
    // quota or resource slot, even while its stop or recycle is unconfirmed;
    // its successor is admitted through this same count, so normal dispatch
    // keeps the limit. A Run cancelled under a pending stop may still be
    // executing and keeps its slot until exit is confirmed.
    for (const run of runs)
      if (
        runHoldsCapacity(run) ||
        (run.status === "queued" && reserved.has(run.id))
      )
        count(run.assignment_id, run);
    for (const action of actions) {
      if (
        action.runtime_ref === null ||
        countedOwners.has(action.assignment_id) ||
        // Idle-session recycle handoffs and system-ended idle turns.
        action.retirement_handoff ||
        action.system_finished_run_id
      )
        continue;
      const owner = owners.get(action.assignment_id);
      if (!owner) continue;
      const history = historyFor(owner);
      const turn = runs
        .filter(
          (r) => r.assignment_id === owner.id && wasDispatched(history, r),
        )
        .reduce<Run | undefined>(
          (last, r) =>
            !last || Number(r.id.slice(2)) > Number(last.id.slice(2))
              ? r
              : last,
          undefined,
        );
      // No turn ever ran, or the last one ended with a business result: idle.
      if (!turn || runEndedByBusiness(turn)) continue;
      count(
        action.assignment_id,
        action.run_id ? tx.runs.get(project.id, action.run_id) : undefined,
        true,
      );
    }
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
  function projectQuotaBlock(
    project: string,
    owner: Assignment,
    keys?: readonly string[],
  ): RunCapacityBlock | undefined {
    const quota = quotas?.(owner.machine_id, project);
    if (!quota) return undefined;
    const machine = owner.machine_id;
    const usage = projectUsage.get(project)?.get(machine);
    if (
      quota.limit !== undefined &&
      !isRunCapacityExempt(owner) &&
      (usage?.occupied ?? 0) >= quota.limit
    )
      return {
        kind: "project_limit",
        project_id: project,
        machine_id: machine,
        limit: quota.limit,
        run_ids: [...(usage?.runs ?? [])],
      };
    for (const key of keys ?? assignmentResourceKeys(tx, project, owner)) {
      const ceiling = quota.resources.get(key);
      if (ceiling !== undefined && (usage?.resources.get(key) ?? 0) >= ceiling)
        return {
          kind: "project_resource",
          project_id: project,
          machine_id: machine,
          resource: key,
          limit: ceiling,
          run_ids: [...(usage?.resourceRuns.get(key) ?? [])],
        };
    }
    return undefined;
  }
  function withinProjectQuota(
    project: string,
    owner: Assignment,
    keys?: readonly string[],
  ): boolean {
    return projectQuotaBlock(project, owner, keys) === undefined;
  }
  /** C-714: the first full project or machine ceiling for this owner, if any. */
  function capacityBlock(
    project: string,
    owner: Assignment,
    keys: readonly string[] = assignmentResourceKeys(tx, project, owner),
  ): RunCapacityBlock | undefined {
    const blocked = projectQuotaBlock(project, owner, keys);
    if (blocked) return blocked;
    const machine = owner.machine_id;
    const slots = resourceSlots(machine);
    for (const key of keys) {
      const slot = slots.get(key);
      // Same test as `remainingResourceRatio(...) <= 0`.
      if (slot && (slot.limit - slot.occupied) / slot.limit <= 0) {
        const held = slotRuns.get(machine)?.get(key) ?? [];
        const own = held.filter((h) => h.project === project);
        return {
          kind: "machine_resource",
          machine_id: machine,
          resource: key,
          limit: slot.limit,
          run_ids: own.map((h) => h.run),
          other_project_runs: held.length - own.length,
        };
      }
    }
    return undefined;
  }
  return {
    withinProjectQuota,
    capacityBlock,
    occupied,
    agentOccupied,
    allAgentOccupied,
    occupiedOwners,
    resourcesForMachine: (machine: string): MachineResources =>
      resourceSlots(machine),
    mergeChecks,
    queue: queueSnapshot(store, tx, reservedRuns),
  };
}

export function readRunQueue(store: Store, tx?: ReadRepositories) {
  return tx
    ? queueSnapshot(store, tx)
    : store.uow.read((read) => queueSnapshot(store, read));
}

/** Shared read-only projection for the execution view and PM project snapshot. */
export function machineRunCapacity(
  store: Store,
  tx: ReadRepositories,
  options: {
    defaults?: ((machine: string) => number) | undefined;
    maximums?: ((machine: string) => number) | undefined;
    displayName?: ((machine: string) => string | undefined) | undefined;
  } = {},
  snapshot = runCapacitySnapshot(store, tx),
): MachineRunCapacity[] {
  const maximums = options.maximums ?? (() => DEFAULT_MAX_RUN_LIMIT);
  return runCapacityMachines(store, tx, options.displayName).map((machine) => ({
    machine_id: machine.id,
    label: machine.label,
    running: snapshot.agentOccupied.get(machine.id) ?? 0,
    total_running: snapshot.allAgentOccupied.get(machine.id) ?? 0,
    limit: effectiveRunLimit(store, machine.id, options.defaults, maximums),
    max_limit: maximums(machine.id),
    queued: snapshot.queue.filter((run) => run.machine_id === machine.id)
      .length,
    merge_check_slots:
      machine.id === LOCAL_EXECUTOR
        ? (snapshot.mergeChecks.get(LOCAL_EXECUTOR) ?? 0) *
          MERGE_CHECK_RUN_SLOTS
        : 0,
  }));
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
