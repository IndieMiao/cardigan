import type { MachinePlacement } from "@cardigan/domain";
import {
  readMachineObservationsInTransaction,
  type Store,
} from "@cardigan/store";
import { effectiveRunLimit, runCapacitySnapshot } from "./run-capacity.js";
import type { RunCapacityConfiguration } from "./run-capacity-config.js";
import {
  loadRuntimeWorkers,
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
    const allowed = new Set<string>();
    if (machines.some((m) => m.id !== "local")) {
      try {
        for (const worker of loadRuntimeWorkers(
          dataDir,
          runtimeWorkersPath(env),
        ))
          if (worker.project_id === project && worker.allow_remote_launch)
            allowed.add(worker.machine_id);
      } catch {
        /* Invalid private configuration never authorizes a remote worker. */
      }
    }
    const { occupied } = runCapacitySnapshot(store, tx);
    return new Map(
      machines.map(({ id }) => [
        id,
        {
          ...readMachineObservationsInTransaction(store, project, id, now),
          launch_allowed: allowed.has(id),
          limit: effectiveRunLimit(
            store,
            id,
            limits.forMachine,
            limits.maxForMachine,
          ),
          occupied: occupied.get(id) ?? 0,
        } satisfies MachinePlacement,
      ]),
    );
  });
}
