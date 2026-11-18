import type { MachinePlacement } from "@cardigan/domain";
import {
  readMachineObservationsInTransaction,
  type Store,
} from "@cardigan/store";
import { effectiveRunLimit, runCapacitySnapshot } from "./run-capacity.js";
import type { RunCapacityConfiguration } from "./run-capacity-config.js";
import {
  loadRuntimeWorkers,
  matchesWorkerPlatform,
  type RuntimeWorker,
  runtimeWorkersPath,
} from "./runtime-workers-config.js";

/** Installed by server and standalone CLI; evaluated only during a new implicit assignment. */
export function configureMachinePlacement(
  store: Store,
  dataDir: string,
  env: NodeJS.ProcessEnv,
  limits: RunCapacityConfiguration,
) {
  store.setMachinePlacementReader((tx, project, now) => {
    const machines = tx.machines.list(project);
    const allowed = new Map<string, RuntimeWorker>();
    if (machines.some((m) => m.id !== "local")) {
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
    const { occupied, resourcesForMachine } = runCapacitySnapshot(
      store,
      tx,
      limits.resourcesForMachine,
    );
    return new Map(
      machines.map((machine) => {
        const { id } = machine;
        const worker = allowed.get(id);
        return [
          id,
          {
            ...readMachineObservationsInTransaction(store, project, id, now),
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
    );
  });
}
