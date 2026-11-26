import type { Clock, ProjectId } from "@cardigan/domain";
import {
  MACHINE_CAPABILITY_INTERVAL_MS,
  type RuntimeTargets,
} from "@cardigan/host";
import type { Store } from "@cardigan/store";
import { type LoopStartup, startTimerLoop } from "./loop.js";
import {
  hasOpenHelperAction,
  reconcileHelperActions,
  siblingHelperConfirmedAt,
} from "./reconcile-helper-actions.js";
import { MachineChecks } from "./web/machine-checks.js";
import type { MachineHost } from "./web/machine-host.js";

/**
 * C-764: how often to look for another project that confirmed the same helper
 * release on a shared machine. Only open confirmations with such a sibling are
 * rechecked; the regular patrol keeps its own interval.
 */
export const HELPER_SIBLING_FOLLOWUP_MS = 60 * 1000;
/** Follow-ups per sibling confirmation, spaced 1, 2, 4 and 8 rounds apart. */
export const HELPER_SIBLING_FOLLOWUP_ATTEMPTS = 4;

export function startMachineCapabilityLoop(options: {
  readonly store: Store;
  readonly startup?: LoopStartup | undefined;
  readonly runtime: Pick<RuntimeTargets, "refreshMachine">;
  readonly verification?: { host: MachineHost; clock: Clock };
  /** C-666: read a remote binding's directory usage after a passing check. */
  readonly usage?: (project: ProjectId, machine: string) => Promise<void>;
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
  // The patrol and the follow-ups never check machines at the same time.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = (work: () => Promise<void>) => {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  };
  /**
   * One project's view of one machine: refresh, then its own double check.
   * Returns whether the fresh check found the machine available.
   */
  const patrol = async (project: string, machine: string) => {
    const record = options.store.uow.read((tx) =>
      tx.machines.get(project, machine),
    );
    if (!record) return false;
    const { health } = await options.runtime.refreshMachine(project, machine, {
      signal: controller.signal,
    });
    // A dispatch pause is not a maintenance failure; the fresh double
    // check still has to prove that it was the only blocker.
    if (
      checks &&
      machine !== "local" &&
      (health?.available ||
        (record.status === "draining" &&
          health?.blockers.length === 1 &&
          health.blockers[0] === "machine_not_ready"))
    )
      await reconcileHelperActions(checks, project, machine);
    return health?.available === true;
  };
  const loop = startTimerLoop({
    startup: options.startup,
    signal: controller.signal,
    name: "machine-capabilities",
    initialDelayMs: options.startup ? 1000 : 0,
    intervalMs: MACHINE_CAPABILITY_INTERVAL_MS,
    // Tools may need several bounded probes. This is independent of dispatch.
    slowTickMs: MACHINE_CAPABILITY_INTERVAL_MS,
    onError: options.onError,
    tick: () =>
      exclusive(async () => {
        for (const project of options.store.listProjects()) {
          const machines = options.store.uow.read((tx) =>
            tx.machines.list(project.id),
          );
          for (const machine of machines) {
            if (controller.signal.aborted) return;
            let available = false;
            try {
              available = await patrol(project.id, machine.id);
            } catch {
              options.onError(new Error("Machine capability refresh failed"));
              continue;
            }
            // Read only through a helper the check just found reachable.
            if (
              options.usage &&
              machine.id !== "local" &&
              available &&
              !controller.signal.aborted
            )
              try {
                await options.usage(project.id, machine.id);
              } catch {
                options.onError(new Error("Worker usage observation failed"));
              }
          }
        }
      }),
  });
  // Keyed by project and machine; a newer sibling confirmation starts over.
  const followups = new Map<
    string,
    { signal: string; attempts: number; wait: number }
  >();
  const failing = new Set<string>();
  const followup =
    checks &&
    startTimerLoop({
      startup: options.startup,
      signal: controller.signal,
      name: "helper-sibling-followup",
      initialDelayMs: HELPER_SIBLING_FOLLOWUP_MS,
      intervalMs: HELPER_SIBLING_FOLLOWUP_MS,
      slowTickMs: MACHINE_CAPABILITY_INTERVAL_MS,
      onError: options.onError,
      tick: () =>
        exclusive(async () => {
          const seen = new Set<string>();
          for (const project of options.store.listProjects()) {
            const machines = options.store.uow.read((tx) =>
              tx.machines.list(project.id),
            );
            for (const { id: machine } of machines) {
              if (controller.signal.aborted) return;
              if (machine === "local") continue;
              const key = `${project.id}\0${machine}`;
              let signal: string | null;
              try {
                signal = hasOpenHelperAction(checks, project.id, machine)
                  ? siblingHelperConfirmedAt(checks, project.id, machine)
                  : null;
                failing.delete(key);
              } catch {
                // The regular patrol and Workbench recheck remain available.
                if (!failing.has(key))
                  options.onError(new Error("Helper sibling lookup failed"));
                failing.add(key);
                seen.add(key);
                continue;
              }
              if (!signal) continue;
              seen.add(key);
              let state = followups.get(key);
              if (state?.signal !== signal) {
                state = { signal, attempts: 0, wait: 0 };
                followups.set(key, state);
              }
              if (state.attempts >= HELPER_SIBLING_FOLLOWUP_ATTEMPTS) continue;
              if (state.wait > 0) {
                state.wait -= 1;
                continue;
              }
              state.attempts += 1;
              state.wait = 2 ** state.attempts - 1;
              try {
                await patrol(project.id, machine);
              } catch {
                options.onError(new Error("Helper sibling follow-up failed"));
              }
            }
          }
          for (const key of followups.keys())
            if (!seen.has(key)) followups.delete(key);
          for (const key of failing) if (!seen.has(key)) failing.delete(key);
        }),
    });
  return {
    done: Promise.all([loop.done, followup?.done]).then(() => {}),
    stop: async () => {
      controller.abort();
      await Promise.all([loop.stop(), followup?.stop()]);
    },
  };
}
