import { createHash } from "node:crypto";
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
} from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import type { ReadRepositories, Store } from "@cardigan/store";

/** Only an opaque revision crosses SSE; never project/card bodies or credentials. */
export function executionCapacityRevision(
  ...args: Parameters<typeof executionCapacity>
) {
  return createHash("sha256")
    .update(JSON.stringify(executionCapacity(...args)))
    .digest("hex")
    .slice(0, 16);
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
      if (tx.runs.get(project, row.run_id as RunId)?.status === "queued")
        details.push(`${row.run_id}：${row.reason}`);
    }
  return details.length ? { lease_details: [...new Set(details)] } : {};
}
