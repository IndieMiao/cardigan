import { dirname, join } from "node:path";
import type { Machine } from "@cardigan/domain";
import {
  type CheckKind,
  type CheckResult,
  helperMismatch,
  loadRuntimeWorkers,
  MachineCheckJournal,
  manualWorkerUpgradeAllowed,
  matchesWorkerPlatform,
  observeRegisteredMachine,
  onboardWorker,
  parseWorkerOnboarding,
  RuntimeTargets,
  readOnboardingYaml,
  refreshWorkerObservations,
  runtimeTargetBinding,
  runtimeWorkersPath,
  upgradeMaterials,
  WORKER_STEPS,
  type WorkerProbeRunner,
  workerCheckConfig,
  workerJournalId,
  workerOnboardingStatus,
} from "@cardigan/host";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";

export interface BindingSummary {
  account: string | null;
  directory: string | null;
  session: string;
  path_entries: number;
}
export interface WizardHost {
  root: string;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  probe?: WorkerProbeRunner;
  refresh?: typeof refreshWorkerObservations;
}
export interface MachineHost {
  readonly wizard?: WizardHost;
  bindingFingerprint?(
    project: string,
    machine: Machine,
    purpose?: "manual-upgrade",
  ): string | undefined;
  upgradeCommand?(project: string, machine: Machine): string | undefined;
  bindings(): (project: string, machine: string) => BindingSummary | null;
  workerRecord(
    project: string,
    machine: string,
  ): {
    status: "failed" | "passed" | "checking" | "unknown";
    checked_at: string;
    failed_steps: readonly string[];
  } | null;
  check(
    project: string,
    machine: string,
    kind: CheckKind,
    progress: (step: string) => void,
    signal: AbortSignal,
    observationId: string,
    confirmation?: { binding: string },
  ): Promise<CheckResult & { readonly maintenance?: CheckResult }>;
}
// This adapter is the only place that touches private files. Neither full targets,
// onboarding repair commands, subprocess output nor exception messages leave it.
export function machineHost(
  store: Store,
  execution: ExecutionConfig,
  session: string,
  env: NodeJS.ProcessEnv,
  browsersPath: () => string | undefined = () => undefined,
): MachineHost {
  const file = runtimeWorkersPath(env),
    root = dirname(file),
    dataDir = execution.dataDir;
  function boundWorker(
    project: string,
    machine: Machine,
    purpose?: "manual-upgrade",
  ) {
    if (
      purpose === "manual-upgrade" &&
      !manualWorkerUpgradeAllowed(root, project, machine.id)
    )
      return undefined;
    const worker = loadRuntimeWorkers(dataDir, file).find(
      (w) => w.machine_id === machine.id && w.project_id === project,
    );
    return worker &&
      machine.id !== "local" &&
      machine.herdr_machine === machine.id &&
      matchesWorkerPlatform(machine, worker) &&
      worker.execution.mode === "agent-ssh"
      ? worker
      : undefined;
  }
  return {
    wizard: { root, dataDir, env },
    bindingFingerprint(project, machine, purpose) {
      const worker = boundWorker(project, machine, purpose);
      return worker && runtimeTargetBinding(worker).fingerprint;
    },
    upgradeCommand(project, machine) {
      const worker = boundWorker(project, machine, "manual-upgrade");
      if (worker?.execution.mode !== "agent-ssh") return undefined;
      // Derive the expected command from this process's release. Never stage on read.
      return upgradeMaterials(
        { ...worker.execution, target: runtimeTargetBinding(worker) },
        machine.os,
      ).terminal.command;
    },
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
      const actual = new MachineCheckJournal(store).latest(
        machine,
        project,
        "worker",
      );
      if (actual)
        return {
          status: actual.status === "running" ? "checking" : actual.status,
          checked_at: actual.checked_at,
          failed_steps: actual.failed_steps,
        };
      const j = workerOnboardingStatus(root, project, machine);
      if (!j) return null;
      const failed_steps = WORKER_STEPS.filter((s) => j.steps[s] === "blocked");
      return {
        checked_at: j.updated_at,
        failed_steps,
        status: failed_steps.length
          ? "failed"
          : WORKER_STEPS.every((s) => j.steps[s] === "passed")
            ? "unknown"
            : "checking",
      };
    },
    async check(
      project,
      machine,
      kind,
      progress,
      signal,
      observationId,
      confirmation,
    ) {
      signal.throwIfAborted();
      if (kind === "machine") {
        progress("runtime");
        const result = await observeRegisteredMachine(
          {
            store,
            project,
            machine,
            env,
            signal,
            progress,
            observationId,
            ...(confirmation ? { helperConfirmation: confirmation } : {}),
            browsersPath,
          },
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
        if (
          result.health?.evidence_ref !== `machine-observation:${observationId}`
        )
          return { status: "failed", failed_steps: ["observation"] };
        // A helper confirmation needs the current helper, not just a compatible one.
        const helper = confirmation
          ? (result.health.warnings ?? []).filter(helperMismatch)
          : [];
        return {
          status:
            result.health.status === "passed" && !helper.length
              ? "passed"
              : "failed",
          failed_steps: [...result.health.blockers, ...helper],
          ...(result.maintenance ? { maintenance: result.maintenance } : {}),
        };
      }

      progress("configuration");
      workerJournalId(project, machine); // Validate both path components before constructing the filename.
      if (process.platform !== "linux")
        return { status: "failed", failed_steps: ["controller_platform"] };
      const draft = parseWorkerOnboarding(
        readOnboardingYaml(join(root, `worker-${machine}-${project}.yaml`)),
        dataDir,
      );
      const workerCheck = workerCheckConfig(
        draft,
        root,
        dataDir,
        confirmation ? "bound" : "check",
      );
      const { config } = workerCheck;
      if (
        (confirmation &&
          runtimeTargetBinding(config.worker).fingerprint !==
            confirmation.binding) ||
        config.worker.machine_id !== machine ||
        config.worker.project_id !== project
      )
        return { status: "failed", failed_steps: ["configuration"] };
      let failed = "configuration";
      const passed = await onboardWorker({
        ...workerCheck,
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
        fullWorkerCheckId: observationId,
        signal,
        browsersPath,
      });
      return {
        status: passed ? "passed" : "failed",
        failed_steps: passed ? [] : [failed],
      };
    },
  };
}
