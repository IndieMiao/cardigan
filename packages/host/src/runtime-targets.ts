import { createHash } from "node:crypto";
import type {
  Assignment,
  Machine,
  ProjectId,
  Role,
  Runtime,
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
  registeredRuntimeOf,
  runtimeDifferences,
  runtimeOwnsRef,
} from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";
import {
  loadRuntimeWorkers,
  type RuntimeWorker,
  runtimeWorkersPath,
} from "./runtime-workers-config.js";

type Adapter = Runtime &
  Partial<RuntimeInteractionReader> &
  Partial<RuntimeLaunchRecovery> &
  Pick<HerdrRuntime, "events" | "probeTerminal" | "captureAgent"> &
  Partial<Pick<HerdrRuntime, "session" | "socketPath">>;
interface Target {
  readonly execution: ExecutionConfig;
  readonly session: string;
  readonly machine: Machine;
}
export interface RuntimeTargetsOptions extends HerdrOptions {
  readonly execution: ExecutionConfig;
  readonly store: Store;
  readonly project?: ProjectId;
  readonly workers?: () => readonly RuntimeWorker[];
  /** Host adapter injection for contract tests; never loaded from configuration. */
  readonly factory?: (options: HerdrOptions) => Promise<RuntimeResult<Adapter>>;
}
const rejected = (): never => {
  throw new Error("Runtime target rejected");
};
const failure = <T>(): RuntimeResult<T> => ({
  ok: false,
  error: { code: "invalid_launch", message: "Runtime target rejected" },
});

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
  resolve(project: ProjectId, machine_id: string): Target {
    if (this.options.project !== undefined && this.options.project !== project)
      return rejected();
    const machine = this.options.store.uow.read((tx) =>
      tx.machines.get(project, machine_id),
    );
    if (!machine) return rejected();
    const workers = this.workers();
    const worker = workers.find(
      (w) => w.project_id === project && w.machine_id === machine_id,
    );
    if (
      !worker &&
      (machine_id !== "local" || workers.some((w) => w.machine_id === "local"))
    )
      return rejected();
    if (worker && (machine.os !== worker.os || machine.arch !== worker.arch))
      return rejected();
    const execution = worker?.execution ?? this.options.execution;
    const session =
      worker?.session ??
      this.options.session ??
      this.options.env?.CARDIGAN_HC_SESSION ??
      "cardigan";
    const generation = worker?.generation ?? "legacy";
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          project,
          machine_id,
          generation,
          registeredRuntimeOf(execution, session),
          execution.dataDir,
          execution.mode === "agent-ssh" ? execution.path : null,
          ...(execution.mode === "agent-ssh" &&
          (execution.publication || execution.fileHelper)
            ? [
                {
                  publication: execution.publication,
                  fileHelper: execution.fileHelper,
                },
              ]
            : []),
        ]),
      )
      .digest("hex");
    return {
      machine,
      session,
      execution: {
        ...execution,
        target: {
          project_id: project,
          machine_id,
          session,
          generation,
          fingerprint,
        },
      },
    };
  }
  /** Call before files, Git, credentials or version probes are touched. */
  forLaunch(project: ProjectId, assignment: Assignment): Target {
    const target = this.resolve(project, assignment.machine_id);
    if (
      assignment.machine_id !== "local" ||
      !["online", "degraded"].includes(target.machine.status)
    )
      return rejected();
    if (assignment.runtime_ref)
      this.targetForRef(assignment.runtime_ref, project);
    return target;
  }
  private targetForRef(
    ref: RuntimeRef,
    expectedProject = this.options.project,
  ): Target {
    const project =
      ref.target?.project_id ??
      this.options.store
        .listProjects()
        .find((p) =>
          this.options.store.uow.read((tx) =>
            tx.assignments
              .list(p.id)
              .some(
                (a) => JSON.stringify(a.runtime_ref) === JSON.stringify(ref),
              ),
          ),
        )?.id ??
      expectedProject;
    if (!project || (expectedProject && expectedProject !== project))
      return rejected();
    const target = this.resolve(project, ref.machine_id);
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
  check(project: ProjectId, machine_id: string) {
    return this.invoke(
      () => this.resolve(project, machine_id),
      async () => ({
        ok: true,
        value: { machine_id, launch_enabled: machine_id === "local" },
      }),
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
  ): Promise<RuntimeResult<T>> {
    try {
      const resolved = target(),
        created = await this.adapter(resolved);
      const current = target();
      if (
        JSON.stringify([resolved.execution, resolved.session]) !==
        JSON.stringify([current.execution, current.session])
      )
        return failure();
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
    } catch {
      return failure();
    }
  }
  provision(
    assignment: Assignment,
    role: Role,
    machine: Machine,
    launch: RuntimeLaunch,
  ) {
    return this.invoke(
      () => {
        const target = this.resolve(
          launch.labels.project as ProjectId,
          assignment.machine_id,
        );
        if (machine.id !== target.machine.id) return rejected();
        return target;
      },
      (runtime) =>
        runtime.provision(
          assignment,
          role,
          this.resolve(
            launch.labels.project as ProjectId,
            assignment.machine_id,
          ).machine,
          launch,
        ),
    );
  }
  wake(ref: RuntimeRef, bell: string, options?: RuntimeWakeOptions) {
    return this.onRef(ref, (runtime) => runtime.wake(ref, bell, options));
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
  resume_or_replace(ref: RuntimeRef, launch: RuntimeLaunch) {
    return this.invoke(
      () => this.targetForRef(ref, launch.labels.project as ProjectId),
      (runtime) => runtime.resume_or_replace(ref, launch),
    );
  }
  human_entry(ref: RuntimeRef) {
    return this.onRef(ref, (runtime) => runtime.human_entry(ref));
  }
  release(ref: RuntimeRef, options: { readonly force: boolean }) {
    return this.onRef(ref, (runtime) => runtime.release(ref, options));
  }
  async retire_idle(
    ref: RuntimeRef,
    options: Parameters<NonNullable<Runtime["retire_idle"]>>[1],
  ) {
    let delegated = false;
    const retired = await this.invoke<{ exited: boolean; withdrawn?: boolean }>(
      () => this.targetForRef(ref, options.project_id),
      (runtime) => {
        if (!runtime.retire_idle)
          return Promise.resolve({
            ok: true,
            value: { exited: false, withdrawn: true },
          });
        delegated = true;
        return runtime.retire_idle(ref, options);
      },
    );
    return !retired.ok && !delegated
      ? { ok: true as const, value: { exited: false, withdrawn: true } }
      : retired;
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
  captureFor(
    project: ProjectId,
    assignment: Assignment,
    command: Parameters<HerdrRuntime["captureAgent"]>[0],
    args: readonly string[],
    timeout?: number,
  ) {
    return this.invoke(
      () => this.forLaunch(project, assignment),
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
