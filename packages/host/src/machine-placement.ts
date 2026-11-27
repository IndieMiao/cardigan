import type { MachinePlacement, MachineResources } from "@cardigan/domain";
import type { Harness, LaunchConfig } from "@cardigan/roles";
import {
  readMachineObservationsInTransaction,
  type Store,
} from "@cardigan/store";
import { observationFingerprint } from "./machine-capabilities.js";
import { effectiveRunLimit, runCapacitySnapshot } from "./run-capacity.js";
import type { RunCapacityConfiguration } from "./run-capacity-config.js";
import { assignmentResourceKeys } from "./run-resources.js";
import { runtimeTargetBinding } from "./runtime-target-fingerprint.js";
import {
  loadRuntimeWorkers,
  matchesWorkerPlatform,
  type RuntimeWorker,
  runtimeWorkersPath,
} from "./runtime-workers-config.js";
import { workerCooldown } from "./worker-maintenance.js";
import { upgradeHeld, upgradeHold } from "./worker-upgrade-gate.js";
import {
  observedWorktreePreparation,
  readWorktreePreparation,
} from "./worktree-preparation.js";

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
      ? readWorktreePreparation(env, now, observedWorktreePreparation(store))
      : undefined;
    const { occupied, occupiedOwners, resourcesForMachine, projectUsage } =
      runCapacitySnapshot(
        store,
        tx,
        limits.resourcesForMachine,
        limits.projectQuota,
      );
    // Placement predicts demand; dispatch still admits these owners using physical slots only.
    const pending = new Map<string, number>();
    // C-716: the same prediction, restricted to this project, for its own quota.
    const pendingHere = new Map<string, number>();
    // C-826: and the resource slots those owners will claim when they start.
    const pendingSlots = new Map<string, Map<string, number>>();
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
        let slots = pendingSlots.get(a.machine_id);
        if (!slots) {
          slots = new Map();
          pendingSlots.set(a.machine_id, slots);
        }
        for (const key of assignmentResourceKeys(tx, p, a))
          slots.set(key, (slots.get(key) ?? 0) + 1);
        if (p === project)
          pendingHere.set(
            a.machine_id,
            (pendingHere.get(a.machine_id) ?? 0) + 1,
          );
      }
    }
    const projectQuota = (
      machine: string,
    ): Pick<MachinePlacement, "project_quota"> => {
      const quota = limits.projectQuota(machine, project);
      if (!quota) return {};
      const usage = projectUsage(project, machine);
      const resources = new Map(
        [...quota.resources].map(([key, limit]) => [
          key,
          { limit, occupied: usage.resources.get(key) ?? 0 },
        ]),
      );
      return {
        project_quota: {
          ...(quota.limit === undefined
            ? {}
            : {
                limit: {
                  limit: quota.limit,
                  occupied: usage.occupied + (pendingHere.get(machine) ?? 0),
                },
              }),
          ...(resources.size ? { resources } : {}),
        },
      };
    };
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
              ...(id !== "local" && upgradeHeld(store, project, id)
                ? {
                    health: {
                      status: "failed" as const,
                      blockers: [upgradeHold],
                      available: false,
                    },
                  }
                : {}),
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
              resources: withPending(
                resourcesForMachine(id),
                pendingSlots.get(id),
              ),
              ...projectQuota(id),
            } satisfies MachinePlacement,
          ];
        }),
      ),
    };
  });
}

/** C-826: physical slot use plus the predicted claims of owners still waiting to start. */
function withPending(
  slots: MachineResources,
  pending: ReadonlyMap<string, number> | undefined,
): MachineResources {
  if (!pending?.size) return slots;
  return new Map(
    [...slots].map(([key, slot]) => [
      key,
      { limit: slot.limit, occupied: slot.occupied + (pending.get(key) ?? 0) },
    ]),
  );
}
