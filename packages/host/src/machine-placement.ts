import type { MachinePlacement } from "@cardigan/domain";
import type { Harness, LaunchConfig } from "@cardigan/roles";
import {
  readMachineObservationsInTransaction,
  type Store,
} from "@cardigan/store";
import { effectiveRunLimit, runCapacitySnapshot } from "./run-capacity.js";
import type { RunCapacityConfiguration } from "./run-capacity-config.js";
import { runtimeTargetBinding } from "./runtime-target-fingerprint.js";
import {
  loadRuntimeWorkers,
  matchesWorkerPlatform,
  type RuntimeWorker,
  runtimeWorkersPath,
} from "./runtime-workers-config.js";
import { readWorktreePreparation } from "./worktree-preparation.js";

/** Installed by server and standalone CLI; evaluated only during a new implicit assignment. */
export function configureMachinePlacement(
  store: Store,
  dataDir: string,
  env: NodeJS.ProcessEnv,
  limits: RunCapacityConfiguration,
  launchConfig: () => LaunchConfig | undefined,
) {
  store.setMachinePlacementReader((tx, project, now, profile) => {
    const machines = tx.machines.list(project);
    const allowed = new Map<string, RuntimeWorker>();
    const hasRemote = machines.some((m) => m.id !== "local");
    if (hasRemote) {
      try {
        for (const worker of loadRuntimeWorkers(
          dataDir,
          runtimeWorkersPath(env),
        ))
          if (worker.project_id === project && worker.allow_remote_launch)
            allowed.set(worker.machine_id, worker);
      } catch {
        /* Invalid private configuration never authorizes a remote worker. */
      }
    }
    const preparation = allowed.size
      ? readWorktreePreparation(env, now)
      : undefined;
    const { occupied, resourcesForMachine } = runCapacitySnapshot(
      store,
      tx,
      limits.resourcesForMachine,
    );
    let harness: Harness | undefined;
    if (hasRemote && profile) {
      try {
        harness = launchConfig()?.profiles[profile]?.harness;
      } catch {
        // Invalid private launch configuration must not authorize remote placement.
      }
    }
    return {
      harness,
      machines: new Map(
        machines.map((machine) => {
          const { id } = machine;
          const worker = allowed.get(id);
          return [
            id,
            {
              ...readMachineObservationsInTransaction(
                store,
                project,
                id,
                now,
                worker && id !== "local"
                  ? runtimeTargetBinding(worker).fingerprint
                  : undefined,
              ),
              ...(worker && id !== "local" && preparation
                ? { worktree_preparation: preparation(worker) }
                : {}),
              remote_binding: !worker
                ? "disabled"
                : matchesWorkerPlatform(machine, worker)
                  ? "allowed"
                  : "platform_mismatch",
              limit: effectiveRunLimit(
                store,
                id,
                limits.forMachine,
                limits.maxForMachine,
              ),
              occupied: occupied.get(id) ?? 0,
              resources: resourcesForMachine(id),
            } satisfies MachinePlacement,
          ];
        }),
      ),
    };
  });
}
