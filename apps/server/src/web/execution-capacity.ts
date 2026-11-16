import { createHash } from "node:crypto";
import {
  DEFAULT_MAX_RUN_LIMIT,
  latestMergeCheck,
  prechecks,
  prepareMergePlan,
} from "@cardigan/domain";
import {
  GithubDispatchJournal,
  type MergeGateConfiguration,
  machineRunCapacity,
  runCapacitySnapshot,
} from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";

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
) {
  return store.uow.read((tx) => {
    const projects = store.listProjects();
    const snapshot = runCapacitySnapshot(store, tx);
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
      agents: machineRunCapacity(
        store,
        tx,
        { defaults, maximums, displayName },
        snapshot,
      ),
      merge_checks: [...checks.values()].sort((a, b) =>
        a.machine_id.localeCompare(b.machine_id),
      ),
      merge_config_invalid,
    };
  });
}
