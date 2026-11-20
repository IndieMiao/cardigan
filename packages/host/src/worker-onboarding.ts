import { randomUUID } from "node:crypto";
import { fsyncSync, renameSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { CpuProfileDirectory } from "./cpu-profile-files.js";
import { loadRunCapacityConfig } from "./run-capacity-config.js";
import {
  checkWorkerDraft,
  checkWorkerSocketPaths,
  onboardingDigest,
  onboardingFail,
  onboardingObject,
  readOnboardingYaml,
  type WorkerOnboardingConfig,
  WorkerOnboardingError,
} from "./worker-onboarding-config.js";
import {
  probeWorker,
  WORKER_PROBES,
  type WorkerProbeRunner,
  workerNextAction,
} from "./worker-onboarding-probes.js";

export * from "./worker-onboarding-config.js";
export * from "./worker-onboarding-probes.js";

export const WORKER_STEPS = [
  "registration",
  "draft",
  ...WORKER_PROBES,
] as const;
type Step = (typeof WORKER_STEPS)[number];
type State = "pending" | "running" | "passed" | "blocked";
export interface WorkerJournal {
  version: 1;
  project: string;
  machine: string;
  digest: string;
  operation: string;
  updated_at: string;
  steps: Record<Step, State>;
}
export function workerJournalId(project: string, machine: string): void {
  if (
    ![project, machine].every((v) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(v),
    ) ||
    machine === "local"
  )
    onboardingFail("worker_identity_invalid");
}
function parseJournal(
  value: unknown,
  project: string,
  machine: string,
): WorkerJournal | undefined {
  if (value === undefined) return undefined;
  const v = onboardingObject(value);
  const steps = onboardingObject(v.steps);
  if (
    v.version !== 1 ||
    v.project !== project ||
    v.machine !== machine ||
    typeof v.digest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(v.digest) ||
    typeof v.operation !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(v.operation) ||
    typeof v.updated_at !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v.updated_at) ||
    WORKER_STEPS.some(
      (s) =>
        !["pending", "running", "passed", "blocked"].includes(String(steps[s])),
    )
  )
    return onboardingFail("worker_journal_invalid");
  // Never return arbitrary JSON fields from an on-disk journal.
  return {
    version: 1,
    project,
    machine,
    digest: v.digest,
    operation: v.operation,
    updated_at: v.updated_at,
    steps: Object.fromEntries(WORKER_STEPS.map((s) => [s, steps[s]])) as Record<
      Step,
      State
    >,
  };
}
function onboardingDirectory(root: string, create: boolean) {
  const config = new CpuProfileDirectory(root);
  try {
    const directory = config.child("worker-onboarding", create);
    try {
      if (create) fsyncSync(config.fd);
      return directory;
    } catch (error) {
      directory.close();
      throw error;
    }
  } finally {
    config.close();
  }
}
function machineDirectory(root: string, machine: string, create: boolean) {
  const journals = onboardingDirectory(root, create);
  try {
    return journals.child(machine, create);
  } finally {
    journals.close();
  }
}

export function workerOnboardingStatus(
  root: string,
  project: string,
  machine: string,
): WorkerJournal | undefined {
  workerJournalId(project, machine);
  let directory: CpuProfileDirectory | undefined;
  try {
    directory = machineDirectory(root, machine, false);
    return parseJournal(directory.read(`${project}.json`), project, machine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    directory?.close();
  }
}

export interface WorkerOnboardingOptions {
  readonly config: WorkerOnboardingConfig;
  readonly configRoot: string;
  readonly dataDir: string;
  readonly mode: "add" | "resume" | "check";
  /** Explicit acknowledgement of the exact newly parsed configuration. */
  readonly confirmConfig?: string;
  /** Only the interactive session can vouch for a completed prefix. CLI checks stay fresh. */
  readonly completed?: readonly Step[];
  /** Must query existing facts and only register offline when allowed. */
  readonly registration: (create: boolean) => Promise<boolean>;
  readonly probe?: WorkerProbeRunner;
  readonly beforeStep?: (step: Step) => void;
  readonly report: (
    step: Step,
    state: State,
    reason: string,
    next?: string,
  ) => void;
}

export async function onboardWorker(
  options: WorkerOnboardingOptions,
): Promise<boolean> {
  const { config, configRoot, dataDir, mode, report } = options;
  const project = config.worker.project_id,
    machine = config.worker.machine_id;
  workerJournalId(project, machine);
  const root = onboardingDirectory(configRoot, true);
  let dir: CpuProfileDirectory | undefined;
  let lock: ReturnType<CpuProfileDirectory["lock"]> | undefined;
  try {
    // Serialize draft identity checks too: two IDs must not claim one endpoint.
    lock = root.lock(true);
    if (!lock.acquire()) return onboardingFail("worker_busy");
    dir = root.child(machine, true);
    fsyncSync(root.fd);
    const directory = dir;
    const filename = `${project}.json`;
    const old = parseJournal(dir.read(filename), project, machine);
    const confirmed =
      mode === "resume" && options.confirmConfig === config.digest;
    if (options.confirmConfig !== undefined && !confirmed)
      return onboardingFail("worker_config_confirmation_invalid");
    if (mode === "resume" && !old)
      return onboardingFail("worker_journal_missing");
    if (old && old.digest !== config.digest && !confirmed)
      return onboardingFail("worker_config_changed");
    const { projects: _projects, ...identity } =
      config.runtime.machines[0] ?? {};
    const binding = {
      identity: onboardingDigest(identity),
      endpoint: onboardingDigest(
        String(config.worker.execution.host).toLowerCase(),
      ),
    };
    checkWorkerDraft(
      config,
      readOnboardingYaml(join(configRoot, "runtime-workers.yaml")),
      dataDir,
      "applied",
    );
    // Drafts for other projects also bind this physical machine before activation.
    for (const machineName of root
      .entries()
      .filter((n) => n !== "owner.lock")) {
      const peer = root.child(machineName, false);
      try {
        const saved = peer.read("machine.binding");
        if (saved !== undefined) {
          const known = onboardingObject(saved);
          if (
            ![known.identity, known.endpoint].every(
              (v) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v),
            )
          )
            onboardingFail("worker_journal_invalid");
          if (
            machineName === machine
              ? known.identity !== binding.identity
              : known.endpoint === binding.endpoint
          )
            onboardingFail("worker_config_conflict");
        }
        for (const name of peer
          .entries()
          .filter((n) => n.endsWith(".runtime-workers.yaml")))
          if (
            !(
              confirmed &&
              machineName === machine &&
              name === `${project}.runtime-workers.yaml`
            )
          )
            checkWorkerDraft(
              config,
              readOnboardingYaml(join(peer.path, name)),
              dataDir,
            );
      } finally {
        peer.close();
      }
    }
    // Bind before registration too: a crash before draft publication must not
    // allow a different project/ID to claim the same physical endpoint.
    if (mode !== "check" && dir.read("machine.binding") === undefined)
      dir.publish("machine.binding", Buffer.from(JSON.stringify(binding)));
    if (confirmed && old) {
      const draft = readOnboardingYaml(
        join(dir.path, `${project}.runtime-workers.yaml`),
      );
      // Immutable audit copy, before clearing any successful steps or replacing
      // the draft. Live configuration and runtime references are never rewritten.
      dir.publish(
        `${project}.${randomUUID()}.history.json`,
        Buffer.from(JSON.stringify({ journal: old, draft })),
      );
    }
    const journal: WorkerJournal = {
      version: 1,
      project,
      machine,
      digest: config.digest,
      operation: confirmed ? randomUUID() : (old?.operation ?? randomUUID()),
      updated_at: new Date().toISOString(),
      steps: Object.fromEntries(
        WORKER_STEPS.map((s) => [s, "pending"]),
      ) as Record<Step, State>,
    };
    const prefix = new Set<Step>();
    if (mode === "resume" && !confirmed && old?.digest === config.digest) {
      for (const step of WORKER_STEPS) {
        if (!options.completed?.includes(step) || old.steps[step] !== "passed")
          break;
        prefix.add(step);
        journal.steps[step] = "passed";
      }
    }
    const persist = () => {
      lock?.verify();
      journal.updated_at = new Date().toISOString();
      directory.write(filename, journal);
    };
    persist();
    for (const step of WORKER_STEPS) {
      if (prefix.has(step)) continue;
      options.beforeStep?.(step);
      journal.steps[step] = "running";
      persist(); // Durable intent before any effect; retries query facts again.
      let passed = false;
      let reason = `worker_${step}_blocked`;
      try {
        if (step === "registration")
          passed = await options.registration(mode !== "check");
        else if (step === "draft") {
          checkWorkerSocketPaths(config);
          const name = `${project}.runtime-workers.yaml`;
          const previous = readOnboardingYaml(join(dir.path, name));
          if (
            previous !== undefined &&
            onboardingDigest(previous) !== onboardingDigest(config.runtime) &&
            !confirmed
          )
            onboardingFail("worker_config_conflict");
          if (previous === undefined && mode !== "check")
            dir.publish(name, Buffer.from(stringify(config.runtime)));
          else if (
            confirmed &&
            onboardingDigest(previous) !== onboardingDigest(config.runtime)
          ) {
            const temporary = `${project}.${randomUUID()}.draft`;
            dir.publish(temporary, Buffer.from(stringify(config.runtime)));
            lock.verify();
            if (
              onboardingDigest(readOnboardingYaml(join(dir.path, name))) !==
              onboardingDigest(previous)
            )
              onboardingFail("worker_config_conflict");
            dir.verify();
            renameSync(dir.at(temporary), dir.at(name));
            fsyncSync(dir.fd);
          }
          passed = true;
        } else {
          // macOS has no cgroup; require an explicit physical-machine ceiling.
          if (step === "resources" && config.worker.os === "darwin") {
            checkWorkerSocketPaths(config);
            const raw = onboardingObject(
              readOnboardingYaml(join(configRoot, "run-capacity.yaml")),
            );
            const entry = onboardingObject(
              onboardingObject(raw.machines)[machine],
            );
            const capacity = await loadRunCapacityConfig({
              configDir: configRoot,
            });
            if (
              capacity.errors.length ||
              !Number.isSafeInteger(entry.limit) ||
              !Number.isSafeInteger(entry.max_limit) ||
              (entry.limit as number) < 1 ||
              (entry.limit as number) > (entry.max_limit as number)
            )
              onboardingFail("worker_run_capacity_required");
          }
          passed = await (options.probe ?? probeWorker)(step, config);
        }
      } catch (error) {
        if (
          error instanceof WorkerOnboardingError &&
          error.code === "worker_macos_socket_path_too_long"
        )
          reason = error.code;
        passed = false;
      }
      journal.steps[step] = passed ? "passed" : "blocked";
      persist();
      const next =
        reason === "worker_macos_socket_path_too_long"
          ? "缩短绑定 session，并同步 LaunchDaemon 的 HC_SESSION；socket 与 holder 路径均不得超过 103 字节。"
          : step === "registration"
            ? "核对项目与机器登记；首次接入请运行 worker add。"
            : step === "draft"
              ? "核对私有配置与已有草案冲突，不覆盖旧文件。"
              : workerNextAction(step, config);
      report(
        step,
        journal.steps[step],
        passed ? "ok" : reason,
        passed ? undefined : next,
      );
      if (!passed) return false;
    }
    return true;
  } finally {
    lock?.close();
    dir?.close();
    root.close();
  }
}
