import {
  DEFAULT_MAX_RUN_LIMIT,
  latestMergeCheck,
  prepareMergePlan,
} from "@cardigan/domain";
import {
  effectiveRunLimit,
  MERGE_CHECK_RUN_SLOTS,
  type MergeGateConfiguration,
  runCapacityMachines,
  runCapacitySnapshot,
} from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store } from "@cardigan/store";

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
    const machines = runCapacityMachines(store, tx, displayName);
    const checks = new Map<
      string,
      { machine_id: string; running: number; limit: number; queued: number }
    >();
    let merge_config_invalid = false;
    for (const project of projects) {
      const config = mergeGate?.forProject(project.id);
      if (config?.status === "invalid") merge_config_invalid = true;
      if (config?.status !== "enabled") continue;
      const machine = config.executor?.name ?? "local";
      const row = checks.get(machine) ?? {
        machine_id: machine,
        running: snapshot.mergeChecks.get(machine) ?? 0,
        limit: config.executor?.maxConcurrent ?? 1,
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
      checks.set(machine, row);
    }
    return {
      agents: machines.map((machine) => ({
        machine_id: machine.id,
        label: machine.label,
        running: snapshot.agentOccupied.get(machine.id) ?? 0,
        limit: effectiveRunLimit(store, machine.id, defaults, maximums),
        max_limit: maximums(machine.id),
        queued: snapshot.queue.filter((run) => run.machine_id === machine.id)
          .length,
        merge_check_slots:
          machine.id === "local"
            ? (snapshot.mergeChecks.get("local") ?? 0) * MERGE_CHECK_RUN_SLOTS
            : 0,
      })),
      merge_checks: [...checks.values()].sort((a, b) =>
        a.machine_id.localeCompare(b.machine_id),
      ),
      merge_config_invalid,
    };
  });
}
