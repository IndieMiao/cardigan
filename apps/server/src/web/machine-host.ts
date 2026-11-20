import { dirname, join } from "node:path";
import {
  checkRegisteredMachine,
  loadRuntimeWorkers,
  matchesWorkerPlatform,
  onboardWorker,
  parseWorkerOnboarding,
  RuntimeTargets,
  readOnboardingYaml,
  refreshWorkerObservations,
  runtimeWorkersPath,
  WORKER_STEPS,
  withMachineCheck,
  workerJournalId,
  workerOnboardingStatus,
} from "@cardigan/host";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";

export type CheckKind = "worker" | "machine";
export interface CheckResult {
  status: "passed" | "failed";
  failed_steps: readonly string[];
}
export interface BindingSummary {
  account: string | null;
  directory: string | null;
  session: string;
  path_entries: number;
}
export interface MachineHost {
  bindings(): (project: string, machine: string) => BindingSummary | null;
  workerRecord(
    project: string,
    machine: string,
  ): {
    status: "failed" | "passed" | "checking";
    checked_at: string;
    failed_steps: readonly string[];
  } | null;
  check(
    project: string,
    machine: string,
    kind: CheckKind,
    progress: (step: string) => void,
    signal: AbortSignal,
  ): Promise<CheckResult>;
}
// This adapter is the only place that touches private files. Neither full targets,
// onboarding repair commands, subprocess output nor exception messages leave it.
export function machineHost(
  store: Store,
  execution: ExecutionConfig,
  session: string,
  env: NodeJS.ProcessEnv,
): MachineHost {
  const file = runtimeWorkersPath(env),
    root = dirname(file),
    dataDir = execution.dataDir;
  return {
    bindings() {
      const workers = loadRuntimeWorkers(dataDir, file);
      return (project, machine) => {
        const worker = workers.find(
          (w) => w.project_id === project && w.machine_id === machine,
        );
        if (
          !worker &&
          (machine !== "local" || workers.some((w) => w.machine_id === "local"))
        )
          return null;
        const target = worker?.execution ?? execution;
        return {
          account:
            target.mode === "agent-ssh" ? (target.user ?? "agent") : null,
          directory: target.mode === "agent-ssh" ? target.agentRoot : null,
          session: worker?.session ?? session,
          path_entries:
            target.mode === "agent-ssh"
              ? (target.path?.split(":").filter(Boolean).length ?? 0)
              : 0,
        };
      };
    },
    workerRecord(project, machine) {
      if (machine === "local") return null;
      const j = workerOnboardingStatus(root, project, machine);
      if (!j) return null;
      const failed_steps = WORKER_STEPS.filter((s) => j.steps[s] === "blocked");
      return {
        checked_at: j.updated_at,
        failed_steps,
        status: failed_steps.length
          ? "failed"
          : WORKER_STEPS.every((s) => j.steps[s] === "passed")
            ? "passed"
            : "checking",
      };
    },
    async check(project, machine, kind, progress, signal) {
      signal.throwIfAborted();
      if (kind === "machine") {
        progress("runtime");
        const result = await checkRegisteredMachine(
          dataDir,
          { store, project, machine, env, signal, progress },
          async () => {
            const runtime = await RuntimeTargets.create({
              store,
              execution,
              session,
              env,
            });
            if (!runtime.ok) throw new Error("Invalid runtime configuration");
            return runtime.value;
          },
        );
        return {
          status: result.health?.status === "passed" ? "passed" : "failed",
          failed_steps: result.health?.blockers ?? ["observation"],
        };
      }
      return withMachineCheck(
        dataDir,
        machine,
        async () => {
          progress("configuration");
          workerJournalId(project, machine); // Validate both path components before constructing the filename.
          if (process.platform !== "linux")
            return { status: "failed", failed_steps: ["controller_platform"] };
          const config = parseWorkerOnboarding(
            readOnboardingYaml(join(root, `worker-${machine}-${project}.yaml`)),
            dataDir,
          );
          if (
            config.worker.machine_id !== machine ||
            config.worker.project_id !== project
          )
            return { status: "failed", failed_steps: ["configuration"] };
          let failed = "configuration";
          const passed = await onboardWorker({
            config,
            configRoot: root,
            dataDir,
            mode: "check",
            registration: async () =>
              store.uow.read(
                (tx) =>
                  !!tx.machines.get(project, machine) &&
                  store.listProjects().every((p) => {
                    const m = tx.machines.get(p.id, machine);
                    return (
                      !m ||
                      (m.herdr_machine === machine &&
                        matchesWorkerPlatform(m, config.worker))
                    );
                  }),
              ),
            beforeStep(step) {
              signal.throwIfAborted();
              progress(step);
            },
            report(step, state) {
              if (state === "blocked") failed = step;
            },
          });
          if (passed) progress("capabilities");
          await refreshWorkerObservations(store, config.worker, passed, env, {
            signal,
          });
          return {
            status: passed ? "passed" : "failed",
            failed_steps: passed ? [] : [failed],
          };
        },
        signal,
      );
    },
  };
}
