import { arch, platform } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type {
  Assignment,
  IdleRetirementResult,
  Machine,
  ProjectId,
  RetirementEvidence,
  RetirementIdentity,
  Role,
  Runtime,
  RuntimeErrorCode,
  RuntimeInteractionReader,
  RuntimeLaunch,
  RuntimeLaunchRecovery,
  RuntimeRef,
  RuntimeResult,
  RuntimeWakeOptions,
} from "@cardigan/domain";
import {
  type ExecutionConfig,
  type HerdrOptions,
  HerdrRuntime,
  type RegisteredRuntime,
  type RuntimeEvent,
  readRegisteredRuntime,
  runtimeDifferences,
  runtimeOwnsRef,
} from "@cardigan/runtime-herdr";
import {
  type ReadRepositories,
  readMachineObservations,
  type Store,
} from "@cardigan/store";
import {
  type MachineObservationOptions,
  refreshMachineObservations,
} from "./machine-capabilities.js";
import {
  type CheckResult,
  MachineCheckJournal,
} from "./machine-check-journal.js";
import { targetProbe } from "./resource-probe.js";
import { runtimeTargetBinding } from "./runtime-target-fingerprint.js";
import {
  loadRuntimeWorkers,
  matchesWorkerPlatform,
  type RuntimeWorker,
  runtimeWorkersPath,
} from "./runtime-workers-config.js";
import { patrolHelperUpgrade } from "./worker-auto-upgrade.js";
import {
  checkWorkerMcpReachability,
  WorkerMcpError,
  workerMcpConfig,
} from "./worker-mcp.js";
import { workerReadiness } from "./worker-readiness.js";
import {
  upgradeHeld,
  upgradeHold,
  upgradeKey,
  upgradeState,
} from "./worker-upgrade-gate.js";

type TargetState = Pick<ReadRepositories, "machines" | "assignments">;
type Adapter = Runtime &
  Partial<RuntimeInteractionReader> &
  Partial<RuntimeLaunchRecovery> &
  Pick<
    HerdrRuntime,
    "events" | "probeTerminal" | "captureAgent" | "checkLocalHealth"
  > &
  Partial<Pick<HerdrRuntime, "session" | "socketPath" | "terminalActivity">>;
interface Target {
  readonly execution: ExecutionConfig;
  readonly session: string;
  readonly machine: Machine;
}
export interface MachineCheck {
  /** Observed at the same instant as machine_not_ready; never dispatch authority. */
  readonly draining?: true;
  readonly machine_id: string;
  readonly blockers: readonly string[];
  readonly launch_enabled: boolean;
}
export interface RuntimeTargetsOptions extends HerdrOptions {
  readonly execution: ExecutionConfig;
  readonly store: Store;
  readonly project?: ProjectId;
  readonly browsersPath?: NonNullable<
    MachineObservationOptions["browsersPath"]
  >;
  readonly workers?: () => readonly RuntimeWorker[];
  /** Host adapter injection for contract tests; never loaded from configuration. */
  readonly factory?: (options: HerdrOptions) => Promise<RuntimeResult<Adapter>>;
  /** Host probe injection for tests; never loaded from project input. */
  readonly workerReadiness?: typeof workerReadiness;
  readonly workerMcpReachability?: typeof checkWorkerMcpReachability;
}
export class RuntimeTargetError extends Error {
  readonly code = "invalid_launch" as const;
  get transient(): boolean {
    return [
      "mcp_timeout",
      "mcp_protocol_error",
      "mcp_gateway_error",
      "mcp_unreachable",
      "worker_unreachable",
      "machine_check_runtime_timeout",
      "machine_check_runtime_queue_timeout",
      "machine_check_runtime_unavailable",
    ].includes(this.reason);
  }
  constructor(readonly reason: string) {
    super(`Runtime target rejected: ${reason}`);
  }
}
/** Only constructed by the router before it delegates this exact launch. An
 * adapter failure (even with the same code or text) is not such a receipt. */
class ProvisionTargetRefusal extends RuntimeTargetError {
  readonly #launch: RuntimeLaunch;
  constructor(launch: RuntimeLaunch, error: unknown) {
    super(
      error instanceof RuntimeTargetError ? error.reason : "target_invalid",
    );
    this.#launch = launch;
  }
  matches(launch: RuntimeLaunch) {
    return this.#launch === launch;
  }
}

export type { ProvisionTargetRefusal };
export function provisionRefusalFor(error: unknown, launch: RuntimeLaunch) {
  return error instanceof ProvisionTargetRefusal && error.matches(launch)
    ? error
    : undefined;
}
const rejected = (reason = "target_mismatch"): never => {
  throw new RuntimeTargetError(reason);
};
const failure = <T>(error?: unknown): RuntimeResult<T> => ({
  ok: false,
  error: {
    code: "invalid_launch",
    message:
      error instanceof RuntimeTargetError
        ? error.message
        : "Runtime target rejected: target_invalid",
  },
});

// Only fixed routing refusals are fit for persistent retirement evidence.
function retirementRefusal(
  code: RuntimeErrorCode,
  cause?: unknown,
): RuntimeResult<IdleRetirementResult> {
  let reason: RetirementEvidence["reason"] = "target_rejected";
  if (cause instanceof RuntimeTargetError) {
    switch (cause.reason) {
      case "machine_unregistered":
      case "worker_unconfigured":
      case "target_mismatch":
      case "target_changed":
        reason = cause.reason;
    }
  }
  return {
    ok: true,
    value: {
      outcome: "withdrawn",
      evidence: { stage: "target", reason, runtime_code: code },
    },
  };
}

/** All production runtime entries share this resolver; refs contain no connection parameters. */
export class RuntimeTargets implements Runtime {
  private readonly adapters = new Map<
    string,
    Promise<RuntimeResult<Adapter>>
  >();
  private readonly workers: () => readonly RuntimeWorker[];
  private constructor(
    private readonly options: RuntimeTargetsOptions,
    private readonly registered: RegisteredRuntime | undefined,
  ) {
    this.workers =
      options.workers ??
      (() =>
        loadRuntimeWorkers(
          options.execution.dataDir,
          runtimeWorkersPath(options.env),
        ));
  }
  static async create(
    options: RuntimeTargetsOptions,
  ): Promise<RuntimeResult<RuntimeTargets>> {
    try {
      const runtime = new RuntimeTargets(
        options,
        await readRegisteredRuntime(options.execution.dataDir),
      );
      runtime.workers(); // Invalid configuration never becomes a local fallback.
      return { ok: true, value: runtime };
    } catch {
      return failure();
    }
  }
  /** Only server registration checks all historical refs; terminal callers check their own ref. */
  assertRegistration(
    execution = this.options.execution,
    session = this.options.session ??
      this.options.env?.CARDIGAN_HC_SESSION ??
      "cardigan",
  ): void {
    if (
      !this.registered ||
      !runtimeDifferences(this.registered, execution, session).length
    )
      return;
    for (const project of this.options.store.listProjects())
      for (const a of this.options.store.uow.read((tx) =>
        tx.assignments.list(project.id),
      ))
        if (
          a.runtime_ref &&
          !a.runtime_ref.target &&
          (session !== this.registered.session ||
            a.runtime_ref.runtime_machine !== "local")
        )
          rejected();
  }
  resolve(project: ProjectId, machine_id: string, state?: TargetState): Target {
    if (this.options.project !== undefined && this.options.project !== project)
      return rejected();
    const read = (tx: TargetState) => tx.machines.get(project, machine_id);
    const machine = state ? read(state) : this.options.store.uow.read(read);
    if (!machine) return rejected("machine_unregistered");
    const workers = this.workers();
    const worker = workers.find(
      (w) => w.project_id === project && w.machine_id === machine_id,
    );
    if (
      !worker &&
      (machine_id !== "local" || workers.some((w) => w.machine_id === "local"))
    )
      return rejected("worker_unconfigured");
    if (worker && !matchesWorkerPlatform(machine, worker)) return rejected();
    const execution = worker?.execution ?? this.options.execution;
    const session =
      worker?.session ??
      this.options.session ??
      this.options.env?.CARDIGAN_HC_SESSION ??
      "cardigan";
    const generation = worker?.generation ?? "legacy";
    return {
      machine,
      session,
      execution: {
        ...execution,
        target: runtimeTargetBinding({
          project_id: project,
          machine_id,
          session,
          generation,
          execution,
        }),
      },
    };
  }
  /** A shared project clone belongs to its configured account, not a historical terminal. */
  forRepository(
    project: ProjectId,
    machine_id: string,
    state?: TargetState,
  ): Target {
    const target = this.resolve(project, machine_id, state);
    if (!["online", "degraded"].includes(target.machine.status))
      return rejected();

    if (
      machine_id !== "local" &&
      upgradeHeld(this.options.store, project, machine_id)
    )
      return rejected(upgradeHold);
    if (
      machine_id !== "local" &&
      (target.execution.mode !== "agent-ssh" || !target.execution.gitHelper)
    )
      return rejected();
    return target;
  }
  /** Git preparation can address a registered worker before runtime launch is enabled. */
  forWorkspace(
    project: ProjectId,
    assignment: Assignment,
    state?: TargetState,
  ): Target {
    const target = this.forRepository(project, assignment.machine_id, state);
    if (
      assignment.runtime_ref &&
      assignment.runtime_ref.machine_id !== assignment.machine_id
    )
      return rejected("target_mismatch");
    if (assignment.runtime_ref)
      this.targetForRef(assignment.runtime_ref, project, state);
    return target;
  }
  /** Call before files, Git, credentials or version probes are touched. */
  private launchTarget(
    project: ProjectId,
    assignment: Pick<Assignment, "machine_id" | "runtime_ref">,
  ): Target {
    const target = this.resolve(project, assignment.machine_id);
    if (!["online", "degraded"].includes(target.machine.status))
      return rejected("machine_not_ready");
    if (assignment.machine_id !== "local") {
      if (upgradeHeld(this.options.store, project, assignment.machine_id))
        return rejected(upgradeHold);
      if (!this.launchAllowed(project, assignment.machine_id))
        return rejected("remote_launch_disabled");
      this.requireWorkerConfiguration(target);
    }
    if (
      assignment.runtime_ref &&
      assignment.runtime_ref.machine_id !== assignment.machine_id
    )
      return rejected("target_mismatch");
    if (assignment.runtime_ref)
      this.targetForRef(assignment.runtime_ref, project);
    return target;
  }
  /** Recheck opt-in at publication boundaries without issuing another probe. */
  assertLaunchAllowed(
    project: ProjectId,
    assignment: Pick<Assignment, "machine_id" | "runtime_ref">,
  ): void {
    this.launchTarget(project, assignment);
  }
  async forLaunch(
    project: ProjectId,
    assignment: Pick<Assignment, "machine_id" | "runtime_ref">,
  ): Promise<Target> {
    const target = this.launchTarget(project, assignment);
    if (assignment.machine_id === "local") return target;
    const checked = await this.check(project, assignment.machine_id);
    if (!checked.ok) return rejected(`machine_check_${checked.error.code}`);
    if (checked.value.blockers.length)
      return rejected(checked.value.blockers[0]);
    const current = this.launchTarget(project, assignment);
    if (
      target.execution.target?.fingerprint !==
      current.execution.target?.fingerprint
    )
      return rejected("target_changed");
    return current;
  }
  // A reused terminal runs this inside its hc send slot. Revalidate the
  // pinned SSH target directly; forLaunch's hc health call would requeue on
  // that same slot. Admission and terminal liveness keep their normal checks.
  readonly publicationResourceProbe = targetProbe(
    async (project, machine_id, pin) => {
      const assignment = { machine_id, runtime_ref: null };
      const target = this.launchTarget(project, assignment);
      if (!pin || target.execution.target?.fingerprint !== pin)
        return rejected("target_changed");
      if (machine_id !== "local") {
        const blockers = await this.workerBlockers(target);
        if (blockers.length) return rejected(blockers[0]);
      }
      return this.checkedTarget(target, project, assignment).execution;
    },
  );
  private async workerBlockers(target: Target): Promise<readonly string[]> {
    const { execution } = target;
    if (execution.mode !== "agent-ssh") return rejected();
    const blockers = await (this.options.workerReadiness ?? workerReadiness)(
      execution,
    );
    if (blockers.length) return blockers;
    try {
      await (this.options.workerMcpReachability ?? checkWorkerMcpReachability)(
        execution,
      );
      return [];
    } catch (error) {
      return [
        error instanceof WorkerMcpError ? error.code : "mcp_worker_failed",
      ];
    }
  }
  private launchAllowed(project: ProjectId, machine: string): boolean {
    return (
      machine === "local" ||
      this.workers().some(
        (w) =>
          w.project_id === project &&
          w.machine_id === machine &&
          w.allow_remote_launch === true,
      )
    );
  }
  private requireWorkerConfiguration(target: Target): void {
    const execution = target.execution;
    if (
      execution.mode !== "agent-ssh" ||
      !execution.gitHelper ||
      !execution.fileHelper ||
      !execution.publication ||
      !execution.path
    )
      rejected("worker_configuration_incomplete");
    if (execution.mode === "agent-ssh") {
      try {
        workerMcpConfig(execution.mcp?.url, execution.mcp?.timeoutMs);
      } catch (error) {
        rejected(
          error instanceof WorkerMcpError ? error.code : "mcp_config_invalid",
        );
      }
    }
  }
  private checkedTarget(
    expected: Target,
    project: ProjectId,
    assignment: Pick<Assignment, "machine_id" | "runtime_ref">,
  ): Target {
    const current = this.launchTarget(project, assignment);
    if (
      expected.execution.target?.fingerprint !==
      current.execution.target?.fingerprint
    )
      return rejected("target_changed");
    return current;
  }
  private targetForRef(
    ref: RuntimeRef,
    expectedProject = this.options.project,
    state?: TargetState,
  ): Target {
    const project =
      ref.target?.project_id ??
      this.options.store.listProjects().find((p) => {
        const owns = (tx: TargetState) =>
          tx.assignments
            .list(p.id)
            .some((a) => JSON.stringify(a.runtime_ref) === JSON.stringify(ref));
        return state ? owns(state) : this.options.store.uow.read(owns);
      })?.id ??
      expectedProject;
    if (!project || (expectedProject && expectedProject !== project))
      return rejected();
    const target = this.resolve(project, ref.machine_id, state);
    if (!ref.target) {
      // Historical refs are usable only with the legacy local configuration.
      if (
        ref.machine_id !== "local" ||
        this.workers().some(
          (w) => w.project_id === project && w.machine_id === "local",
        )
      )
        return rejected();
      const legacy = this.options.execution;
      const session = this.registered?.session ?? target.session;
      if (target.session !== session) return rejected();
      const execution =
        ref.runtime_machine === "local"
          ? { mode: "local" as const, dataDir: legacy.dataDir }
          : legacy;
      if (!runtimeOwnsRef(execution, ref)) return rejected();
      if (
        ref.runtime_machine !== "local" &&
        this.registered &&
        runtimeDifferences(this.registered, execution, session).length
      )
        return rejected();
      return { ...target, execution, session };
    }
    if (!runtimeOwnsRef(target.execution, ref)) return rejected();
    const alias = ref.runtime_machine;
    if (
      !(
        alias === "local"
          ? /^t[a-z0-9]+$/u
          : new RegExp(`^${alias}/t[a-z0-9]+$`, "u")
      ).test(ref.terminal_ref)
    )
      return rejected();
    return target;
  }
  ownsRef(ref: RuntimeRef): boolean {
    try {
      this.targetForRef(ref);
      return true;
    } catch {
      return false;
    }
  }
  forProject(project: ProjectId): RuntimeTargets {
    if (this.options.project && this.options.project !== project)
      return rejected();
    return new RuntimeTargets({ ...this.options, project }, this.registered);
  }
  check(
    project: ProjectId,
    machine_id: string,
    forObservation = false,
  ): Promise<RuntimeResult<MachineCheck>> {
    return this.rawMachineCheck(project, machine_id).then((result) => {
      if (
        result.ok &&
        machine_id !== "local" &&
        upgradeHeld(this.options.store, project, machine_id)
      ) {
        const row = upgradeState(this.options.store, project, machine_id);
        if (
          forObservation &&
          row?.state === "worker_checked" &&
          row.release_key ===
            upgradeKey(
              this.resolve(project, machine_id).execution.target?.fingerprint,
            )
        )
          return result;
        return {
          ...result,
          value: {
            ...result.value,
            blockers: [...result.value.blockers, upgradeHold],
            launch_enabled: false,
          },
        };
      }
      return result;
    });
  }
  private rawMachineCheck(
    project: ProjectId,
    machine_id: string,
  ): Promise<RuntimeResult<MachineCheck>> {
    return this.invoke<MachineCheck>(
      () => {
        const target = this.resolve(project, machine_id);
        if (machine_id !== "local") this.requireWorkerConfiguration(target);
        return target;
      },
      async (runtime) => {
        const target = this.resolve(project, machine_id);
        // Health is a live observation for local execution accounts too.
        const live =
          target.execution.mode === "local"
            ? await runtime.checkLocalHealth()
            : await runtime.captureAgent("git", ["--version"]);
        if (!live.ok) return live;
        let blockers: readonly string[] = [];
        if (
          target.execution.mode === "local" &&
          (target.machine.os !== platform() || target.machine.arch !== arch())
        )
          blockers = ["machine_platform_mismatch"];
        if (machine_id !== "local")
          blockers = await this.workerBlockers(target);
        const current = this.resolve(project, machine_id);
        if (
          target.execution.target?.fingerprint !==
          current.execution.target?.fingerprint
        )
          return rejected("target_changed");
        if (!["online", "degraded"].includes(current.machine.status))
          blockers = [...blockers, "machine_not_ready"];
        return {
          ok: true,
          value: {
            machine_id,
            ...(current.machine.status === "draining"
              ? { draining: true as const }
              : {}),
            blockers,
            launch_enabled:
              blockers.length === 0 && this.launchAllowed(project, machine_id),
          },
        };
      },
    );
  }
  refreshMachine(
    project: ProjectId,
    machine: string,
    overrides: Pick<
      MachineObservationOptions,
      "catalog" | "probe" | "now" | "signal" | "progress"
    > = {},
  ) {
    return checkRegisteredMachine(
      {
        store: this.options.store,
        project,
        machine,
        ...(this.options.env ? { env: this.options.env } : {}),
        ...(this.options.browsersPath
          ? { browsersPath: this.options.browsersPath }
          : {}),
        ...overrides,
      },
      () => this,
      "patrol",
      async (job) => {
        const execution = this.resolve(project, machine).execution;
        const check = async () => {
          const result = await this.rawMachineCheck(project, machine);
          return result.ok
            ? result.value
            : { blockers: [result.error.code], launch_enabled: false };
        };
        return patrolHelperUpgrade(
          {
            store: this.options.store,
            project,
            machine,
            execution,
            job,
            env: this.options.env,
            signal: overrides.signal,
            bindingCurrent: () =>
              this.resolve(project, machine).execution.target?.fingerprint ===
              execution.target?.fingerprint,
            check,
          },
          await check(),
        );
      },
    );
  }
  executionForRef(ref: RuntimeRef, project?: ProjectId): ExecutionConfig {
    return this.targetForRef(ref, project).execution;
  }
  private adapter(target: Pick<Target, "execution" | "session">) {
    const key = JSON.stringify([target.execution, target.session]);
    let cached = this.adapters.get(key);
    if (!cached) {
      cached = (this.options.factory ?? HerdrRuntime.create)({
        ...this.options,
        execution: target.execution,
        session: target.session,
        // The router enforces current opt-in and live checks at every launch entry.
        allowRemoteLaunch: true,
      });
      this.adapters.set(key, cached);
      void cached.then(
        (result) => {
          if (!result.ok) this.adapters.delete(key);
        },
        () => this.adapters.delete(key),
      );
    }
    return cached;
  }
  private async invoke<T>(
    target: () => Pick<Target, "execution" | "session">,
    call: (runtime: Adapter) => Promise<RuntimeResult<T>>,
    onTargetRefusal?: (
      code: RuntimeErrorCode,
      cause?: unknown,
    ) => RuntimeResult<T>,
  ): Promise<RuntimeResult<T>> {
    let delegated = false;
    try {
      const resolved = target(),
        created = await this.adapter(resolved);
      const current = target();
      if (
        JSON.stringify([resolved.execution, resolved.session]) !==
        JSON.stringify([current.execution, current.session])
      )
        return (
          onTargetRefusal?.(
            "invalid_launch",
            new RuntimeTargetError("target_changed"),
          ) ?? failure()
        );
      if (!created.ok && onTargetRefusal)
        return onTargetRefusal(created.error.code);
      delegated = created.ok;
      const result = created.ok ? await call(created.value) : created;
      return result.ok
        ? result
        : {
            ok: false,
            error: {
              ...result.error,
              message: `Runtime operation rejected: ${result.error.code}`,
            },
          };
    } catch (error) {
      return !delegated && onTargetRefusal
        ? onTargetRefusal("invalid_launch", error)
        : failure(error);
    }
  }
  async provision(
    assignment: Assignment,
    role: Role,
    machine: Machine,
    launch: RuntimeLaunch,
    beforeAdapter?: () => void,
  ): Promise<RuntimeResult<RuntimeRef>> {
    let checked: Target;
    try {
      checked = await this.forLaunch(
        launch.labels.project as ProjectId,
        assignment,
      );
    } catch (error) {
      return { ok: false, error: new ProvisionTargetRefusal(launch, error) };
    }
    return this.invoke(
      () => {
        const target = this.checkedTarget(
          checked,
          launch.labels.project as ProjectId,
          assignment,
        );
        if (machine.id !== target.machine.id) return rejected();
        return target;
      },
      (runtime) => {
        const current = this.resolve(
          launch.labels.project as ProjectId,
          assignment.machine_id,
        ).machine;
        beforeAdapter?.();
        return runtime.provision(assignment, role, current, launch);
      },
    );
  }
  wake(ref: RuntimeRef, bell: string, options?: RuntimeWakeOptions) {
    if (ref.machine_id === "local")
      return this.onRef(ref, (runtime) => runtime.wake(ref, bell, options));
    const current = () => {
      if (!ref.target) return rejected("target_mismatch");
      return this.launchTarget(ref.target.project_id, {
        machine_id: ref.machine_id,
        runtime_ref: ref,
      });
    };
    return this.invoke(current, (runtime) =>
      runtime.wake(ref, bell, {
        ...options,
        before_send: () => {
          if (options?.before_send && !options.before_send()) return false;
          try {
            // Recheck after hc FIFO/slot waits, immediately before the actual send.
            current();
            return true;
          } catch {
            return false;
          }
        },
      }),
    );
  }
  find_launch(assignment: Assignment, launch: RuntimeLaunch) {
    return this.invoke(
      () =>
        this.resolve(launch.labels.project as ProjectId, assignment.machine_id),
      (runtime) =>
        runtime.find_launch
          ? runtime.find_launch(assignment, launch)
          : Promise.resolve(failure<RuntimeRef>()),
    );
  }
  private onRef<T>(
    ref: RuntimeRef,
    call: (runtime: Adapter) => Promise<RuntimeResult<T>>,
  ) {
    return this.invoke(() => this.targetForRef(ref), call);
  }
  terminalActivity(ref: RuntimeRef, project: string, assignment: string) {
    const target = () => this.targetForRef(ref, project);
    return this.invoke(target, async (runtime) => {
      const observation = await runtime.terminalActivity?.(
        ref,
        project,
        assignment,
      );
      target(); // A replaced worker must not contribute a late screen sample.
      return observation ?? rejected();
    });
  }
  interaction(
    ref: RuntimeRef,
    identity: { project_id: string; assignment_id: string; harness: string },
  ) {
    return this.onRef(
      ref,
      (runtime) =>
        runtime.interaction?.(ref, identity) ??
        Promise.resolve({ ok: true as const, value: "unknown" as const }),
    );
  }
  status(ref: RuntimeRef) {
    return this.onRef(ref, (runtime) => runtime.status(ref));
  }
  interrupt(ref: RuntimeRef) {
    return this.onRef(ref, (runtime) => runtime.interrupt(ref));
  }
  async resume_or_replace(
    ref: RuntimeRef,
    launch: RuntimeLaunch,
    beforeAdapter?: () => void,
  ): Promise<RuntimeResult<RuntimeRef>> {
    const project = launch.labels.project as ProjectId;
    const assignment = { machine_id: ref.machine_id, runtime_ref: ref };
    let checked: Target | undefined;
    if (ref.machine_id !== "local") {
      try {
        checked = await this.forLaunch(project, assignment);
      } catch (error) {
        return { ok: false, error: new ProvisionTargetRefusal(launch, error) };
      }
    }
    return this.invoke(
      () =>
        checked
          ? this.checkedTarget(checked, project, assignment)
          : this.targetForRef(ref, project),
      (runtime) => {
        beforeAdapter?.();
        return runtime.resume_or_replace(ref, launch);
      },
    );
  }
  human_entry(ref: RuntimeRef) {
    return this.onRef(ref, (runtime) => runtime.human_entry(ref));
  }
  release(ref: RuntimeRef, options: { readonly force: boolean }) {
    return this.onRef(ref, (runtime) => runtime.release(ref, options));
  }
  confirm_local_exit(ref: RuntimeRef, owner: RetirementIdentity) {
    return this.invoke(
      () => this.targetForRef(ref, owner.project_id),
      (runtime) =>
        runtime.confirm_local_exit?.(ref, owner) ??
        Promise.resolve({ ok: true as const, value: false }),
    );
  }
  observe_prompt(
    ref: RuntimeRef,
    binding: NonNullable<RuntimeWakeOptions["prompt_binding"]>,
  ) {
    return this.invoke(
      () => this.targetForRef(ref, binding.project_id),
      (runtime) =>
        runtime.observe_prompt?.(ref, binding) ??
        Promise.resolve({ ok: true as const, value: false }),
    );
  }
  observe_retirement(ref: RuntimeRef, identity: RetirementIdentity) {
    return this.invoke(
      () => this.targetForRef(ref, identity.project_id),
      (runtime) =>
        runtime.observe_retirement?.(ref, identity) ??
        Promise.resolve({ ok: true as const, value: "unknown" as const }),
    );
  }
  async retire_idle(
    ref: RuntimeRef,
    options: Parameters<NonNullable<Runtime["retire_idle"]>>[1],
  ) {
    return this.invoke<IdleRetirementResult>(
      () => this.targetForRef(ref, options.project_id),
      (runtime) => {
        if (!runtime.retire_idle)
          return Promise.resolve({
            ok: true,
            value: {
              outcome: "withdrawn",
              evidence: { stage: "target", reason: "unsupported" },
            },
          });
        return runtime.retire_idle(ref, options);
      },
      retirementRefusal,
    );
  }
  probeTerminal(ref: RuntimeRef) {
    return this.onRef(ref, (runtime) => runtime.probeTerminal(ref));
  }
  attachEnvironment(ref: RuntimeRef) {
    return this.invoke<{ session: string; socketPath: string }>(
      () => this.targetForRef(ref),
      async (runtime) =>
        runtime.session && runtime.socketPath
          ? {
              ok: true,
              value: {
                session: runtime.session,
                socketPath: runtime.socketPath,
              },
            }
          : failure(),
    );
  }
  async *events(
    ref: RuntimeRef,
    signal?: AbortSignal,
  ): AsyncGenerator<RuntimeResult<RuntimeEvent>> {
    try {
      const target = this.targetForRef(ref),
        created = await this.adapter(target);
      if (!created.ok) {
        yield {
          ok: false,
          error: {
            code: created.error.code,
            message: "Runtime subscription rejected",
          },
        };
        return;
      }
      for await (const event of created.value.events(ref, signal)) {
        this.targetForRef(ref); // A changed configuration invalidates an open stream too.
        yield event.ok
          ? event
          : {
              ok: false,
              error: {
                code: event.error.code,
                message: "Runtime subscription rejected",
              },
            };
      }
    } catch {
      yield failure();
    }
  }
  async captureFor(
    project: ProjectId,
    assignment: Assignment,
    command: Parameters<HerdrRuntime["captureAgent"]>[0],
    args: readonly string[],
    timeout?: number,
  ) {
    let checked: Target;
    try {
      checked = await this.forLaunch(project, assignment);
    } catch (error) {
      // Version discovery keeps the typed cause; other invalid launches remain permanent.
      return error instanceof RuntimeTargetError
        ? { ok: false as const, error }
        : failure<string>(error);
    }
    return this.invoke(
      () => this.checkedTarget(checked, project, assignment),
      (runtime) => runtime.captureAgent(command, args, timeout),
    );
  }
  /** Existing local Git assembly; project worker Git is delivered separately. */
  captureAgent(
    command: Parameters<HerdrRuntime["captureAgent"]>[0],
    args: readonly string[],
    timeout?: number,
  ) {
    return this.invoke(
      () => {
        if (this.options.project)
          return this.resolve(this.options.project, "local");
        if (this.workers().some((worker) => worker.machine_id === "local"))
          return rejected();
        return {
          execution: this.options.execution,
          session: this.options.session ?? "cardigan",
        };
      },
      (runtime) => runtime.captureAgent(command, args, timeout),
    );
  }
}

/** Construct the target inside the observation fence: invalid private configuration must
 * revoke stale health/capabilities just like a failed probe. Used by CLI, Web and patrol. */
export async function observeRegisteredMachine(
  options: Omit<MachineObservationOptions, "target" | "check"> & {
    helperConfirmation?: { binding: string };
  },
  create: () => Promise<RuntimeTargets> | RuntimeTargets,
  patrolCheck?: (job: string) => ReturnType<MachineObservationOptions["check"]>,
) {
  const { project, machine } = options;
  let runtime: RuntimeTargets | undefined;
  const ready = async () => (runtime ??= await create());
  let draining = false;
  const result = await refreshMachineObservations({
    ...options,
    target: async () => {
      const target = (await ready()).resolve(project, machine);
      if (
        options.helperConfirmation &&
        target.execution.target?.fingerprint !==
          options.helperConfirmation.binding
      )
        throw new Error("Machine target changed");
      return target;
    },
    check: async () => {
      if (patrolCheck && options.observationId)
        return patrolCheck(options.observationId);
      const checked = await (await ready()).check(project, machine, true);
      draining = checked.ok && checked.value.draining === true;
      return checked.ok
        ? {
            blockers: checked.value.blockers,
            launch_enabled: checked.value.launch_enabled,
          }
        : { blockers: [checked.error.code], launch_enabled: false };
    },
  });
  // Never publish maintenance success as normal health or dispatch evidence. Only
  // the confirmation that owns this exact observation can ignore a dispatch pause.
  let maintenance: CheckResult | undefined;
  if (
    options.helperConfirmation &&
    options.observationId &&
    draining &&
    result.health?.evidence_ref ===
      `machine-observation:${options.observationId}` &&
    result.health.blockers.includes("machine_not_ready")
  ) {
    const failed_steps = result.health.blockers.filter(
      (s) => s !== "machine_not_ready",
    );
    maintenance = {
      status: failed_steps.length ? "failed" : "passed",
      failed_steps,
    };
  }
  return { ...result, ...(maintenance ? { maintenance } : {}) };
}
export async function checkRegisteredMachine(
  options: Parameters<typeof observeRegisteredMachine>[0],
  create: Parameters<typeof observeRegisteredMachine>[1],
  source: "cli" | "patrol" = "cli",
  patrolCheck?: (job: string) => ReturnType<MachineObservationOptions["check"]>,
) {
  const journal = new MachineCheckJournal(options.store);
  for (;;) {
    options.signal?.throwIfAborted();
    const { job, joined } = journal.claim(
      options.project,
      options.machine,
      "machine",
      source,
    );
    if (!joined)
      return journal.execute(
        job,
        (progress) => {
          progress("runtime");
          return observeRegisteredMachine(
            {
              ...options,
              observationId: job.id,
              progress: (step) => {
                progress(step);
                options.progress?.(step);
              },
            },
            create,
            patrolCheck,
          );
        },
        (r) => ({
          status: r.health?.available ? "passed" : "failed",
          failed_steps: r.health?.blockers ?? ["observation"],
        }),
      );
    // No CLI/patrol caller may use a different project's observations. Wait for
    // the slot; only reuse evidence when this binding's machine check finished.
    while (journal.read(options.machine, job.id)?.status === "running") {
      await delay(100, undefined, { signal: options.signal });
    }
    if (job.kind === "machine" && job.project_id === options.project) {
      const observations = readMachineObservations(
        options.store,
        options.project,
        options.machine,
        options.now?.(),
      );
      // Another check may already have superseded the one we joined.
      if (
        observations.health?.evidence_ref === `machine-observation:${job.id}` &&
        observations.health.status !== "checking"
      )
        return observations;
    }
  }
}
