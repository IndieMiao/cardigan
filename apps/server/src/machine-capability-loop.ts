import {
  MACHINE_CAPABILITY_INTERVAL_MS,
  type RuntimeTargets,
} from "@cardigan/host";
import type { Store } from "@cardigan/store";
import { type LoopStartup, startTimerLoop } from "./loop.js";

export function startMachineCapabilityLoop(options: {
  readonly store: Store;
  readonly startup?: LoopStartup | undefined;
  readonly runtime: Pick<RuntimeTargets, "refreshMachine">;
  readonly onError: (error: unknown) => void;
}) {
  const controller = new AbortController();
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
            await options.runtime.refreshMachine(project.id, machine.id, {
              signal: controller.signal,
            });
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
