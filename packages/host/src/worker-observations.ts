import type { Store } from "@cardigan/store";
import {
  type MachineObservationOptions,
  refreshMachineObservations,
} from "./machine-capabilities.js";
import { runtimeTargetBinding } from "./runtime-target-fingerprint.js";
import {
  matchesWorkerPlatform,
  type RuntimeWorker,
} from "./runtime-workers-config.js";
import { WorkerOnboardingError } from "./worker-onboarding-config.js";

/** Both callers must publish evidence for the exact binding that was probed. */
export async function refreshWorkerObservations(
  store: Store,
  worker: RuntimeWorker,
  passed: boolean,
  env: NodeJS.ProcessEnv,
  options: Pick<
    MachineObservationOptions,
    "signal" | "probe" | "browsersPath"
  > = {},
) {
  const { project_id: project, machine_id: machine } = worker;
  const checkedRegistration = () => {
    const registered = store.uow.read((tx) =>
      tx.machines.get(project, machine),
    );
    return registered &&
      registered.herdr_machine === machine &&
      matchesWorkerPlatform(registered, worker)
      ? registered
      : undefined;
  };
  if (checkedRegistration()) {
    const execution = {
      ...worker.execution,
      target: runtimeTargetBinding(worker),
    };
    const observations = await refreshMachineObservations({
      store,
      project,
      machine,
      env,
      ...options,
      // The wizard probes its input configuration, not an arbitrary later registration.
      // Resolve both sides of the observation fence against that same worker.
      target: () => {
        const registered = checkedRegistration();
        if (!registered)
          throw new WorkerOnboardingError("worker_identity_conflict");
        return { execution, machine: registered };
      },
      check: async () => ({
        blockers: passed ? [] : ["worker_check_failed"],
        launch_enabled: false,
      }),
    });
    if (passed && !observations.health?.available)
      throw new WorkerOnboardingError("worker_capability_check_failed");
  } else if (passed) {
    throw new WorkerOnboardingError("worker_identity_conflict");
  }
}
