import type { MachinePlacement } from "@cardigan/domain";
import type { Harness, LaunchConfig } from "@cardigan/roles";
import {
  readMachineObservationsInTransaction,
  type Store,
} from "@cardigan/store";
import { observationFingerprint } from "./machine-capabilities.js";
import { effectiveRunLimit, runCapacitySnapshot } from "./run-capacity.js";
import type { RunCapacityConfiguration } from "./run-capacity-config.js";
import { runtimeTargetBinding } from "./runtime-target-fingerprint.js";
import {
  loadRuntimeWorkers,
  matchesWorkerPlatform,
  type RuntimeWorker,
  runtimeWorkersPath,
} from "./runtime-workers-config.js";
import { workerCooldown } from "./worker-maintenance.js";
import { readWorktreePreparation } from "./worktree-preparation.js";

/** Installed by server and standalone CLI; evaluated only during a new implicit assignment. */
export function configureMachinePlacement(
  store: Store,
  dataDir: string,
  env: NodeJS.ProcessEnv,
  limits: RunCapacityConfiguration,
  launchConfig: () => LaunchConfig | undefined,
) {
  store.setMachinePlacementReader((tx, project, now, profile, draft) => {
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
    const { occupied, occupiedOwners, resourcesForMachine } =
      runCapacitySnapshot(store, tx, limits.resourcesForMachine);
    // Placement predicts demand; dispatch still admits these owners using physical slots only.
    const pending = new Map<string, number>();
    for (const [p, holding] of occupiedOwners) {
      const work = p === project ? draft : undefined;
      const runs = work?.runs ?? tx.runs.list(p);
      const seen = new Set(runs.map((r) => r.assignment_id));
      const queued = new Set(
        runs.filter((r) => r.status === "queued").map((r) => r.assignment_id),
      );
      const closed = new Set(
        tx.cards
          .list(p)
          .filter((c) => c.status === "done" || c.status === "cancelled")
          .map((c) => c.id),
      );
      const items = new Map(
        (work?.work_items ?? tx.work_items.list(p)).map((w) => [w.id, w]),
      );
      for (const a of work?.assignments ?? tx.assignments.list(p)) {
        if (
          a.scope !== "work_item" ||
          a.external ||
          a.status !== "active" ||
          holding.has(a.id) ||
          (seen.has(a.id) && !queued.has(a.id))
        )
          continue;
        const item = items.get(a.work_item_id);
        if (
          item?.assignment_id !== a.id ||
          closed.has(item.card_id) ||
          !["todo", "ready", "in_progress", "changes_requested"].includes(
            item.status,
          )
        )
          continue;
        pending.set(a.machine_id, (pending.get(a.machine_id) ?? 0) + 1);
      }
    }
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
          const binding =
            worker && id !== "local"
              ? runtimeTargetBinding(worker).fingerprint
              : undefined;
          return [
            id,
            {
              ...(binding
                ? workerCooldown(store, project, id, binding, now)
                : {}),
              ...readMachineObservationsInTransaction(
                store,
                project,
                id,
                now,
                observationFingerprint(binding, machine),
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
              occupied: (occupied.get(id) ?? 0) + (pending.get(id) ?? 0),
              pending_assignments: pending.get(id) ?? 0,
              resources: resourcesForMachine(id),
            } satisfies MachinePlacement,
          ];
        }),
      ),
    };
  });
}
