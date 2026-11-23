import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  DEFAULT_MAX_RUN_LIMIT,
  latestMergeCheck,
  prechecks,
  prepareMergePlan,
  type RunId,
} from "@cardigan/domain";
import {
  GithubDispatchJournal,
  type MergeGateConfiguration,
  machineRunCapacity,
  type ReadResourceLimits,
  runCapacitySnapshot,
  runningMergeChecks,
} from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import type { ReadRepositories, Store } from "@cardigan/store";

/** Only an opaque revision crosses SSE; never project/card bodies or credentials. */
export function executionCapacityRevision(
  ...args: Parameters<typeof executionCapacity>
) {
  return capacityRevisionOf(executionCapacity(...args));
}

function capacityRevisionOf(view: ExecutionCapacityView): string {
  return createHash("sha256")
    .update(JSON.stringify(view))
    .digest("hex")
    .slice(0, 16);
}

export type ExecutionCapacityView = ReturnType<typeof executionCapacity>;

/**
 * C-634: the stored inputs of the capacity view, as counters and small rows
 * instead of the view itself. `command_versions` advances with every write to
 * cards, work items, Assignments, Runs, deliveries, events (merge checks,
 * prechecks, GitHub dispatch intents, host ops) and BellAttempts; the tables
 * without those triggers are read whole, and leases only while active at
 * `now`. Read it before the view, so a write landing in between only costs one
 * extra rebuild, never a stale view.
 */
export function executionCapacityInputs(store: Store, now: string): string {
  const db = store.database;
  return store.uow.read(() =>
    JSON.stringify([
      db
        .prepare(
          "SELECT project_id, collection, version FROM command_versions ORDER BY project_id, collection",
        )
        .all()
        .map((row) => [row.project_id, row.collection, row.version]),
      db
        .prepare(
          "SELECT machine, resource, project, starts_at, ends_at, binding, verified_at, run_id FROM machine_resource_leases WHERE ends_at>? OR (binding IS NOT NULL AND verified_at IS NULL) ORDER BY machine, resource, starts_at, generation",
        )
        .all(now)
        .map((row) => Object.values(row)),
      db
        .prepare(
          "SELECT machine, project, run_id, reason FROM machine_resource_waits ORDER BY machine, project, run_id",
        )
        .all()
        .map((row) => Object.values(row)),
      db
        .prepare(
          "SELECT machine_id, doc FROM run_capacity_limits ORDER BY machine_id",
        )
        .all()
        .map((row) => [row.machine_id, row.doc]),
      // Includes owner liveness: a dead check process releases its slot.
      [...runningMergeChecks(store)].sort(([a], [b]) => a.localeCompare(b)),
      store.listProjects().map((project) => project.id),
    ]),
  );
}

/** Rebuild at least this often when no counted input moved (clock and process inputs). */
export const CAPACITY_REFRESH_MS = 10_000;

/**
 * C-634: one capacity view per project shared by every SSE connection and the
 * GET endpoint. It is rebuilt only when `executionCapacityInputs` changed or
 * the refresh interval passed; the revision is still the hash of the view, so
 * a client refetches exactly when the view it would get differs.
 */
export class ExecutionCapacityCache {
  readonly #entries = new Map<
    string,
    {
      inputs: string;
      builtAt: number;
      view: ExecutionCapacityView;
      revision: string;
    }
  >();
  constructor(
    private readonly options: {
      readonly inputs: (now: string) => string;
      readonly build: (
        project: string | undefined,
        now: string,
      ) => ExecutionCapacityView;
      readonly now: () => string;
      readonly refreshMs?: number;
      readonly monotonicMs?: () => number;
    },
  ) {}

  read(project: string | undefined): {
    view: ExecutionCapacityView;
    revision: string;
  } {
    const now = this.options.now();
    const at = this.options.monotonicMs?.() ?? performance.now();
    const inputs = this.options.inputs(now);
    const key = project ?? "";
    const cached = this.#entries.get(key);
    if (
      cached &&
      cached.inputs === inputs &&
      at - cached.builtAt < (this.options.refreshMs ?? CAPACITY_REFRESH_MS)
    )
      return cached;
    const view = this.options.build(project, now);
    const entry = {
      inputs,
      builtAt: at,
      view,
      revision: capacityRevisionOf(view),
    };
    this.#entries.set(key, entry);
    return entry;
  }

  revision(project: string | undefined): string {
    return this.read(project).revision;
  }
}

/** All projects share machine capacity; return only display fields, never executor credentials. */
export function executionCapacity(
  store: Store,
  defaults?: (machine: string) => number,
  mergeGate?: MergeGateConfiguration,
  maximums: (machine: string) => number = () => DEFAULT_MAX_RUN_LIMIT,
  displayName?: (machine: string) => string | undefined,
  resourceLimits?: ReadResourceLimits,
  project?: string,
  now = new Date().toISOString(),
) {
  return store.uow.read((tx) => {
    const projects = store.listProjects();
    const snapshot = runCapacitySnapshot(store, tx, resourceLimits);
    const checks = new Map<
      string,
      {
        machine_id: string;
        running: number;
        limit: number;
        queued: number;
        executor_type: "local" | "ssh" | "github";
        target_limit: number;
      }
    >();
    const remote = new GithubDispatchJournal(store)
      .allAt(tx)
      .filter((intent) => !intent.finished);
    let merge_config_invalid = false;
    for (const project of projects) {
      const config = mergeGate?.forProject(project.id);
      if (config?.status === "invalid") merge_config_invalid = true;
      if (config?.status !== "enabled") continue;
      const machine = config.executor?.name ?? "local";
      const row = checks.get(machine) ?? {
        machine_id: machine,
        running: Math.max(
          snapshot.mergeChecks.get(machine) ?? 0,
          remote.filter((intent) => intent.executor === machine).length,
        ),
        executor_type: config.executor
          ? (config.executor.type ?? "ssh")
          : "local",
        target_limit: config.executor?.maxConcurrent ?? 1,
        limit:
          config.executor?.type === "github"
            ? config.executor.maxConcurrent
            : 1,
        queued: 0,
      };
      const state = loadCommandState(tx, project.id, {
        merge_gate_enabled: true,
      });
      for (const card of state.cards) {
        if (card.status !== "awaiting_merge") continue;
        const plan = prepareMergePlan(state, card.id);
        if (
          plan.ok &&
          latestMergeCheck(state.events, card.id, plan.value.completion_id)
            ?.status === "queued"
        )
          row.queued++;
      }
      row.queued += prechecks(state.events).filter(
        (check) => check.status === "queued",
      ).length;
      checks.set(machine, row);
    }
    return {
      // MC-5: configured resource slots only; unconfigured resources are unlimited.
      agents: machineRunCapacity(
        store,
        tx,
        { defaults, maximums, displayName },
        snapshot,
      ).map((machine) => ({
        ...machine,
        ...leaseDetails(store, tx, project, machine.machine_id, now),
        resources: [...snapshot.resourcesForMachine(machine.machine_id)]
          .map(([key, slot]) => ({
            key,
            occupied: slot.occupied,
            limit: slot.limit,
          }))
          .sort((a, b) => a.key.localeCompare(b.key)),
      })),
      merge_checks: [...checks.values()].sort((a, b) =>
        a.machine_id.localeCompare(b.machine_id),
      ),
      merge_config_invalid,
    };
  });
}

function leaseDetails(
  store: Store,
  tx: ReadRepositories,
  project: string | undefined,
  machine: string,
  now: string,
) {
  const rows = store.database
    .prepare(
      `SELECT resource,project,starts_at,ends_at,binding,verified_at,run_id FROM machine_resource_leases WHERE machine=? AND (ends_at>? OR (binding IS NOT NULL AND verified_at IS NULL)) ORDER BY starts_at,generation`,
    )
    .all(machine, now);
  const details = rows.map((row) => {
    const key = String(row.resource);
    if (row.ends_at && String(row.ends_at) > now)
      return `${key}：${row.project === project ? "本项目" : "其它项目"}预约 ${row.starts_at} — ${row.ends_at}`;
    return `${key}：${row.run_id && tx.runs.get(String(row.project), row.run_id as RunId)?.status === "running" ? "已占用" : "等待释放核验"}`;
  });
  if (project)
    for (const row of store.database
      .prepare(
        "SELECT run_id,reason FROM machine_resource_waits WHERE machine=? AND project=? ORDER BY run_id",
      )
      .all(machine, project)) {
      if (
        ["queued", "dispatched"].includes(
          tx.runs.get(project, row.run_id as RunId)?.status ?? "",
        )
      )
        details.push(`${row.run_id}：${row.reason}`);
    }
  return details.length ? { lease_details: [...new Set(details)] } : {};
}
