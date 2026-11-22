import type { Clock } from "@cardigan/domain";
import {
  MACHINE_CAPABILITY_INTERVAL_MS,
  type RuntimeTargets,
} from "@cardigan/host";
import type { Store } from "@cardigan/store";
import { type LoopStartup, startTimerLoop } from "./loop.js";
import { reconcileHelperActions } from "./reconcile-helper-actions.js";
import { MachineChecks } from "./web/machine-checks.js";
import type { MachineHost } from "./web/machine-host.js";

export function startMachineCapabilityLoop(options: {
  readonly store: Store;
  readonly startup?: LoopStartup | undefined;
  readonly runtime: Pick<RuntimeTargets, "refreshMachine">;
  readonly verification?: { host: MachineHost; clock: Clock };
  readonly onError: (error: unknown) => void;
}) {
  const controller = new AbortController();
  const checks =
    options.verification &&
    new MachineChecks(
      options.store,
      options.verification.clock,
      controller.signal,
      options.verification.host,
    );
  const loop = startTimerLoop({
    startup: options.startup,
    signal: controller.signal,
    name: "machine-capabilities",
    initialDelayMs: options.startup ? 1000 : 0,
    intervalMs: MACHINE_CAPABILITY_INTERVAL_MS,
    // Tools may need several bounded probes. This is independent of dispatch.
    slowTickMs: MACHINE_CAPABILITY_INTERVAL_MS,
    onError: options.onError,
    tick: async () => {
      for (const project of options.store.listProjects()) {
        const machines = options.store.uow.read((tx) =>
          tx.machines.list(project.id),
        );
        for (const machine of machines) {
          if (controller.signal.aborted) return;
          try {
            const { health } = await options.runtime.refreshMachine(
              project.id,
              machine.id,
              {
                signal: controller.signal,
              },
            );
            // A dispatch pause is not a maintenance failure; the fresh double
            // check still has to prove that it was the only blocker.
            if (
              checks &&
              machine.id !== "local" &&
              (health?.available ||
                (machine.status === "draining" &&
                  health?.blockers.length === 1 &&
                  health.blockers[0] === "machine_not_ready"))
            ) {
              await reconcileHelperActions(checks, project.id, machine.id);
            }
          } catch {
            options.onError(new Error("Machine capability refresh failed"));
          }
        }
      }
    },
  });
  return {
    ...loop,
    stop: () => {
      controller.abort();
      return loop.stop();
    },
  };
}
