import {
  HC_RELEASE,
  isHcVersionCompatible,
  warnIfHcUntested,
} from "./hc-version.js";

export {
  HC_RELEASE,
  isHcCompatible,
  isHcVersionCompatible,
} from "./hc-version.js";

import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { loopbackTerminal, managedLoopback } from "./loopback-terminal.js";

export { managedLoopback } from "./loopback-terminal.js";

import { enrollDarwinOwner, stopDarwinOwner } from "./darwin-idle-owner.js";
import { darwinRetirementObservation } from "./darwin-retirement.js";
import { idleRetirementHelper } from "./idle-retirement.js";
import { confirmationVisible } from "./interaction.js";
import { terminalSnapshot } from "./terminal-activity.js";

export * from "./check-recovery.js";
export * from "./worker-capabilities.js";
export * from "./worker-files.js";
export * from "./worker-preflight.js";
export {
  WorkerPreparationFailure,
  WorkerTransportUnavailable,
} from "./worker-preparation-failure.js";
export * from "./worker-primitives.js";

import { join } from "node:path";
import type {
  Assignment,
  IdleRetirementResult,
  Machine,
  PromptObservation,
  RetirementEvidence,
  RetirementIdentity,
  Role,
  Runtime,
  RuntimeError,
  RuntimeLaunch,
  RuntimeObservation,
  RuntimeRef,
  RuntimeResult,
  RuntimeWakeOptions,
  RuntimeWakeResult,
} from "@cardigan/domain";
import { type AgentBinary, isAgentBinary } from "@cardigan/domain";
import { registerAgentMachine } from "./agent-ssh.js";
import { boundPrompt } from "./bound-prompt.js";
import {
  type GovernedHcClient,
  governHcClient,
  hcCallPolicy,
} from "./call-queue.js";
import { type CoreEvents, coreEvents } from "./core-events.js";
import { runtimeOwnsRef } from "./registered.js";
import type { RuntimeEvent } from "./runtime-event.js";

export {
  AGENT_PATH,
  type AgentCheckListing,
  type AgentCheckPaths,
  type AgentListRunner,
  agentCleanupCheckCommand,
  agentListChecks,
  agentPrepareCheckCommand,
  agentProcessCommand,
  agentReceivePack,
  agentUploadPack,
  mirrorReceivePack,
  validateSshConfig,
} from "./agent-ssh.js";
export {
  type HcCallDiagnostics,
  type HcCallPolicy,
  hcCallPolicy,
} from "./call-queue.js";
export type { RuntimeEvent } from "./runtime-event.js";

import {
  type AgentCommandFailure,
  fail,
  type HcClient,
  processClient,
  RuntimeFailure,
  result,
} from "./client.js";

// The test harnesses wrap the real client so a late call cannot restart a core.
export {
  type AgentCommandFailure,
  agentCommandError,
  type HcClient,
  processClient,
} from "./client.js";

import {
  type ExecutionConfig,
  resolveExecutionConfig,
  within,
} from "./execution.js";

export {
  type AgentExecution,
  checkLockName,
  clearAgentSentinel,
  type LaunchFile,
  matchesAgentBundleOrigin,
  prepareAgentCheckout,
  prepareAgentProject,
  prepareCheckLock,
  prepareCheckoutAlias,
  START_FILE_NAME,
  scrubAgentLaunch,
  secureDataDirectory,
  writeAgentLaunch,
  writeAgentSentinel,
} from "./agent-files.js";

export {
  defaultDataDirectory,
  type ExecutionConfig,
  type ExecutionEnv,
  executionPaths,
  executionPermissions,
  LOCAL_RUNTIME_WARNING,
  resolveDataDirectory,
  resolveExecutionConfig,
} from "./execution.js";

export {
  DEFAULT_HC_SESSION,
  describeRuntime,
  REGISTERED_RUNTIME_FILE,
  type RegisteredRuntime,
  readRegisteredRuntime,
  registeredRuntimeOf,
  runtimeDifferences,
  runtimeMachineOf,
  runtimeOwnsRef,
  writeRegisteredRuntime,
} from "./registered.js";

export interface HerdrOptions {
  /** Only the host target router enables this after enforcing remote launch policy. */
  readonly allowRemoteLaunch?: boolean;
  readonly execution?: ExecutionConfig;
  readonly binary?: string;
  readonly session?: string;
  readonly socketPath?: string;
  /** Optional stricter minimum; cannot lower the repository floor. */
  readonly version?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly client?: HcClient;
}

type Terminal = {
  address: string;
  state: string;
  labels?: Record<string, string>;
  status?: { state: string } | null;
  pid?: number | null;
  foreground?: Parameters<typeof terminalSnapshot>[1];
  created_ms?: number;
  keep?: boolean;
};
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
const statusStates = new WeakMap<
  object,
  {
    requests: Map<string, Promise<RuntimeResult<RuntimeObservation>>>;
    epochs: Map<string, number>;
  }
>();

export class HerdrRuntime implements Runtime {
  private readonly hub: CoreEvents;
  private readonly statusRequests: Map<
    string,
    Promise<RuntimeResult<RuntimeObservation>>
  >;
  private readonly statusEpochs: Map<string, number>;
  // Per-adapter, bounded and intentionally not persisted. A cold adapter must
  // decline if the core is down, rather than trusting a PID from stored input.
  private readonly localProcesses = new Map<
    string,
    {
      id: string;
      project: string;
      assignment: string;
      name: string;
      launch: RuntimeRef["launch_generation"];
      pid: number;
    }
  >();
  private constructor(
    readonly session: string,
    readonly socketPath: string,
    private binary: string,
    private client: GovernedHcClient,
    private execution: ExecutionConfig,
    private timeoutMs: number,
    private version: string,
    private readonly allowRemoteLaunch: boolean,
  ) {
    this.hub = coreEvents(client.queue, client);
    let state = statusStates.get(client.queue);
    if (!state) {
      state = { requests: new Map(), epochs: new Map() };
      statusStates.set(client.queue, state);
    }
    this.statusRequests = state.requests;
    this.statusEpochs = state.epochs;
  }
  static async create(
    options: HerdrOptions = {},
  ): Promise<RuntimeResult<HerdrRuntime>> {
    return result(async () => {
      const session =
        options.session ?? process.env.CARDIGAN_HC_SESSION ?? "cardigan";
      if (!/^[a-zA-Z0-9_-]{1,48}$/u.test(session))
        fail("invalid_launch", "Invalid hc session name");
      const binary = options.binary ?? "hc";
      const execution =
        options.execution ??
        resolveExecutionConfig({ ...process.env, ...options.env });
      if (execution.target && execution.target.session !== session)
        fail("invalid_launch", "Runtime target session mismatch");
      const socket =
        options.socketPath ??
        join(
          process.env.XDG_RUNTIME_DIR ??
            join(tmpdir(), `cardigan-${process.getuid?.() ?? "local"}`),
          "cardigan",
          `${session}.sock`,
        );
      const timeout = options.timeoutMs ?? 10000;
      if (!Number.isFinite(timeout) || timeout <= 0)
        fail("invalid_launch", "Invalid runtime timeout");
      const raw =
        options.client ??
        processClient(
          binary,
          {
            ...process.env,
            ...options.env,
            HC_SESSION: session,
            HC_SOCKET: socket,
          },
          socket,
          timeout,
          true,
        );
      const client = governHcClient(raw, {
        socket,
        session,
        policy: hcCallPolicy({ ...process.env, ...options.env }),
        ...(options.client ? {} : { dataDir: execution.dataDir }),
      });
      const version = options.version ?? HC_RELEASE.minimum_version;
      const actual = /^hc (\S+)$/.exec(
        (await client.exec(["--version"])).trim(),
      )?.[1];
      if (
        !isHcVersionCompatible(version) ||
        !isHcVersionCompatible(actual, version)
      )
        fail("version_mismatch", "Unsupported hc version");
      warnIfHcUntested(actual);
      if (execution.mode === "agent-ssh")
        await registerAgentMachine(client, execution, session, version);
      return new HerdrRuntime(
        session,
        socket,
        binary,
        client,
        execution,
        timeout,
        version,
        options.allowRemoteLaunch === true,
      );
    });
  }
  private async live() {
    if (!(await this.client.available()))
      fail("runtime_unavailable", "hc socket is absent");
    // A cached adapter must not trust an alias which was rebound in hc.
    if (this.execution.mode === "agent-ssh")
      await registerAgentMachine(
        this.client,
        this.execution,
        this.session,
        this.version,
      );
  }
  private async json(args: string[]) {
    await this.live();
    return JSON.parse(await this.client.exec([...args, "--json"]));
  }
  diagnostics() {
    return {
      ...this.client.queue.diagnostics(),
      event_subscriptions: this.hub.sources,
      event_consumers: this.hub.subscribers,
      status_requests: this.statusRequests.size,
    };
  }
  private invalidateStatus(ref: RuntimeRef) {
    this.statusEpochs.set(
      ref.terminal_ref,
      (this.statusEpochs.get(ref.terminal_ref) ?? 0) + 1,
    );
  }
  private checkRef(ref: RuntimeRef) {
    const machine =
      this.execution.mode === "local" ? "local" : this.execution.machine;
    const terminal =
      machine === "local"
        ? ref.terminal_ref
        : ref.terminal_ref.startsWith(`${machine}/`)
          ? ref.terminal_ref.slice(machine.length + 1)
          : "";
    if (!runtimeOwnsRef(this.execution, ref) || !/^t[a-z0-9]+$/u.test(terminal))
      fail(
        "invalid_launch",
        "Terminal must belong to the configured runtime machine",
      );
  }
  private validateLaunch(launch: RuntimeLaunch) {
    if (
      !/^[a-z0-9_-]{1,32}$/u.test(launch.agent_name) ||
      !launch.command ||
      !launch.cwd ||
      !launch.labels.project ||
      !launch.labels.run ||
      (this.execution.target &&
        launch.labels.project !== this.execution.target.project_id) ||
      (launch.args.length === 0 && !/^[\w./+-]+$/u.test(launch.command))
    )
      fail("invalid_launch", "Invalid runtime launch description");
    if (
      this.execution.mode === "agent-ssh" &&
      !within(this.execution.agentRoot, launch.cwd)
    )
      fail("invalid_launch", "Agent cwd must be inside its work root");
  }
  private checkTerminal(ref: RuntimeRef, terminal: Terminal) {
    if (
      ref.launch_generation &&
      (terminal.labels?.run !== ref.launch_generation.run_id ||
        terminal.labels.generation !== ref.launch_generation.generation ||
        (ref.target && terminal.labels.project !== ref.target.project_id))
    )
      fail("invalid_launch", "Terminal launch generation changed");
  }
  private checkLaunchEnabled() {
    if (
      this.execution.target &&
      this.execution.target.machine_id !== "local" &&
      !this.allowRemoteLaunch
    )
      fail("invalid_launch", "Remote worker launch is not enabled");
  }
  private async launch(launch: RuntimeLaunch, keep: boolean) {
    this.checkLaunchEnabled();
    this.validateLaunch(launch);
    // An explicit launch may bootstrap hc; probes must not do so. SSH aliases
    // still need their pinned endpoint/session/version checked before run.
    if (this.execution.mode === "agent-ssh")
      await registerAgentMachine(
        this.client,
        this.execution,
        this.session,
        this.version,
      );
    const args = [
      "run",
      ...(this.execution.mode === "agent-ssh"
        ? ["--on", this.execution.machine]
        : []),
      "--bg",
      "--json",
      "--no-parent",
      "--no-notify",
      "--name",
      launch.agent_name,
      "--cwd",
      launch.cwd,
    ];
    if (keep) args.push("--keep");
    for (const [key, value] of Object.entries(launch.labels))
      args.push("--label", `${key}=${value}`);
    // run stops parsing options at the program: all hc options must precede it.
    const launched = JSON.parse(
      await this.client.exec([...args, "--", launch.command, ...launch.args]),
    );
    if (typeof launched.address !== "string")
      fail("runtime_unavailable", "hc did not return a terminal address");
    this.localProcesses.delete(launched.address);
    return launched.address as string;
  }
  /** Remember only the real local, non-kept terminal just created by this launch.
   * The signal-zero probes only check existence. No PID crosses the runtime port. */
  private async localProcessReceipt(
    ref: RuntimeRef,
    launch: RuntimeLaunch,
    assignment: Assignment,
  ) {
    if (
      this.execution.mode !== "local" ||
      assignment.machine_id !== "local" ||
      process.platform !== "linux"
    )
      return;
    try {
      const t: Terminal = await this.json(["get", ref.terminal_ref]);
      const project = launch.labels.project;
      if (!project) return;
      this.checkRetirementTerminal(
        ref,
        { project_id: project, assignment_id: assignment.id },
        t,
      );
      const pid = t.pid;
      if (
        !pid ||
        !Number.isSafeInteger(pid) ||
        pid <= 1 ||
        t.keep !== false ||
        t.state !== "live" ||
        t.labels?.run !== launch.labels.run
      )
        return;
      process.kill(pid, 0);
      process.kill(-pid, 0);
      const id = randomUUID();
      if (this.localProcesses.size >= 1024) {
        const oldest = this.localProcesses.keys().next().value;
        if (oldest) this.localProcesses.delete(oldest);
      }
      this.localProcesses.set(ref.terminal_ref, {
        id,
        project,
        assignment: assignment.id,
        name: ref.agent_name,
        launch: ref.launch_generation,
        pid,
      });
      return id;
    } catch {
      // This evidence is optional; do not roll back a successful launch.
      return;
    }
  }
  confirm_local_exit(ref: RuntimeRef, owner: RetirementIdentity) {
    return result(async () => {
      this.checkRef(ref);
      const receipt = this.localProcesses.get(ref.terminal_ref);
      if (
        this.execution.mode !== "local" ||
        ref.machine_id !== "local" ||
        !receipt ||
        receipt.id !== ref.local_process_receipt ||
        receipt.project !== owner.project_id ||
        receipt.assignment !== owner.assignment_id ||
        receipt.name !== ref.agent_name ||
        receipt.launch?.run_id !== ref.launch_generation?.run_id ||
        receipt.launch?.generation !== ref.launch_generation?.generation
      )
        return false;
      // PID reuse, permission errors, a surviving group and an inaccessible or
      // replaced socket are all ambiguous. Never start hc or signal a process.
      for (const pid of [receipt.pid, -receipt.pid]) {
        try {
          process.kill(pid, 0);
          return false;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ESRCH") return false;
        }
      }
      try {
        await lstat(this.socketPath);
        return false;
      } catch (err) {
        return (
          (err as NodeJS.ErrnoException).code === "ENOENT" &&
          this.localProcesses.get(ref.terminal_ref) === receipt
        );
      }
    });
  }
  provision(
    assignment: Assignment,
    role: Role,
    machine: Machine,
    launch: RuntimeLaunch,
  ) {
    return result(async () => {
      if (
        assignment.machine_id !==
          (this.execution.target?.machine_id ?? "local") ||
        machine.id !== assignment.machine_id ||
        role.role_id !== assignment.role_id ||
        role.version !== assignment.role_version ||
        !launch.labels.project ||
        !launch.labels.run
      )
        fail("invalid_launch", "Launch identity or labels do not match");
      const terminal_ref = await this.launch(
        {
          ...(await enrollDarwinOwner(
            this.execution,
            assignment,
            role,
            launch,
          )),
          labels: {
            ...launch.labels,
            cardigan: "1",
            assignment: assignment.id,
          },
        },
        false,
      );
      const ref: RuntimeRef = {
        machine_id: machine.id,
        runtime_machine:
          this.execution.mode === "local" ? "local" : this.execution.machine,
        terminal_ref,
        agent_name: launch.agent_name,
        ...(launch.labels.generation
          ? {
              launch_generation: {
                run_id: launch.labels.run as import("@cardigan/domain").RunId,
                generation: launch.labels.generation,
              },
            }
          : {}),
        ...(this.execution.target ? { target: this.execution.target } : {}),
        ...(assignment.worktree_path
          ? { worktree_path: assignment.worktree_path }
          : {}),
        ...(assignment.branch ? { branch: assignment.branch } : {}),
      };
      this.checkRef(ref);
      this.invalidateStatus(ref);
      const receipt = await this.localProcessReceipt(ref, launch, assignment);
      return receipt ? { ...ref, local_process_receipt: receipt } : ref;
    });
  }
  find_launch(assignment: Assignment, launch: RuntimeLaunch) {
    return result(async () => {
      this.validateLaunch(launch);
      if (
        assignment.machine_id !==
          (this.execution.target?.machine_id ?? "local") ||
        !launch.labels.generation ||
        launch.labels.assignment !== assignment.id
      )
        fail("invalid_launch", "Launch identity mismatch");
      const alias =
        this.execution.mode === "local" ? "local" : this.execution.machine;
      const terminal: Terminal = await this.json([
        "get",
        alias === "local" ? launch.agent_name : `${alias}/${launch.agent_name}`,
      ]);
      if (
        ["project", "assignment", "run", "generation"].some(
          (key) => terminal.labels?.[key] !== launch.labels[key],
        )
      )
        fail("invalid_launch", "Recovered terminal labels mismatch");
      const ref: RuntimeRef = {
        machine_id: assignment.machine_id,
        runtime_machine: alias,
        terminal_ref: terminal.address,
        agent_name: launch.agent_name,
        ...(this.execution.target ? { target: this.execution.target } : {}),
        launch_generation: {
          run_id: launch.labels.run as import("@cardigan/domain").RunId,
          generation: launch.labels.generation,
        },
      };
      this.checkRef(ref);
      return ref;
    });
  }
  observe_prompt(ref: RuntimeRef, binding: PromptObservation) {
    return result(async () => {
      this.checkRef(ref);
      return !!(await boundPrompt(this.client, ref, binding));
    });
  }
  wake(ref: RuntimeRef, doorbell: string, options?: RuntimeWakeOptions) {
    return result<RuntimeWakeResult>(async () => {
      this.checkRef(ref);
      this.checkLaunchEnabled();
      await this.live();
      if (ref.launch_generation)
        this.checkTerminal(ref, await this.json(["get", ref.terminal_ref]));
      this.invalidateStatus(ref);
      try {
        const guard = options?.observed_guard;
        let ifIdle = options?.if_idle || guard?.state === "unknown";
        const sent = await this.client.execIfCurrent(
          () => [
            "send",
            "--json",
            ...(ifIdle ? ["--if", "idle"] : []),
            "--",
            ref.terminal_ref,
            doorbell,
          ],
          options?.before_send ?? (() => true),
          (guard ||
            options?.retirement_owner ||
            options?.resource_preflight ||
            options?.prompt_binding) &&
            (async (raw) => {
              try {
                if (
                  options?.resource_preflight &&
                  !(await options.resource_preflight())
                )
                  return false;
                if (options?.prompt_binding) {
                  const state = await boundPrompt(
                    raw,
                    ref,
                    options.prompt_binding,
                  );
                  if (!state) return false;
                  ifIdle ||= state === "idle";
                }
                if (!guard && !options?.retirement_owner) return true;
                // Read through the reserved slot, not the queue (capacity may be one).
                const terminalState = async () => {
                  const t: Terminal = JSON.parse(
                    await raw.exec(["get", ref.terminal_ref, "--json"]),
                  );
                  if (options?.retirement_owner)
                    this.checkRetirementTerminal(
                      ref,
                      options.retirement_owner,
                      t,
                    );
                  else this.checkTerminal(ref, t);
                  return t.address === ref.terminal_ref && t.state === "live"
                    ? (t.status?.state ?? "unknown")
                    : undefined;
                };
                const before = await terminalState();
                if (!guard) return before === "idle";
                if (guard.state === "done") return before === "done";
                if (before !== "unknown" && before !== "idle") return false;
                // A transcript end is a hint, not a condition hc can enforce.
                // Only an explicit idle transition can promote this hint to a
                // send, and --if idle rechecks it when hc actually types.
                return (
                  (await guard.confirm_turn_end()) &&
                  (await terminalState()) === "idle"
                );
              } catch {
                return false; // A failed observation proves nothing about idleness.
              }
            }),
        );
        return sent ? { sent: true } : { sent: false, withdrawn: true };
      } finally {
        this.invalidateStatus(ref);
      }
    });
  }
  /** Host-only local health probe; never executes an arbitrary host command. */
  checkLocalHealth(): Promise<RuntimeResult<void>> {
    return result(async () => {
      if (this.execution.mode !== "local")
        fail("invalid_launch", "Local health check requires the local runtime");
      // Read-only core request: a cached adapter must observe current liveness.
      await this.json(["ls"]);
    });
  }
  /** Host orchestration only: run Git or inspect an installed Agent CLI as agent. */
  async captureAgent(
    command: "git" | AgentBinary,
    args: readonly string[],
    timeoutMs?: number,
  ): Promise<
    | { readonly ok: true; readonly value: string }
    | {
        readonly ok: false;
        readonly error: RuntimeError & {
          readonly detail?: AgentCommandFailure;
        };
      }
  > {
    let detail: AgentCommandFailure | undefined;
    const captured = await result(async () => {
      if (
        this.execution.mode !== "agent-ssh" ||
        (command !== "git" && !isAgentBinary(command))
      )
        fail(
          "invalid_launch",
          "Agent command requires the configured SSH runtime",
        );
      await this.live();
      // hc exec emits program stdout and propagates its exit status, unlike JSON control calls.
      const input = [
        "exec",
        "--on",
        this.execution.machine,
        "--",
        command,
        ...args,
      ];
      try {
        return await (timeoutMs === undefined
          ? this.client.exec(input)
          : this.client.exec(input, timeoutMs));
      } catch (error) {
        if (error instanceof RuntimeFailure) detail = error.detail;
        throw error;
      }
    });
    return !captured.ok && detail
      ? { ok: false, error: { ...captured.error, detail } }
      : captured;
  }
  async *events(
    ref: RuntimeRef,
    signal?: AbortSignal,
  ): AsyncGenerator<RuntimeResult<RuntimeEvent>> {
    const ready = await result(async () => {
      this.checkRef(ref);
      await this.live();
      if (ref.launch_generation)
        this.checkTerminal(ref, await this.json(["get", ref.terminal_ref]));
    });
    if (!ready.ok) {
      yield ready;
      return;
    }
    try {
      for await (const event of this.hub.subscribe(signal)) {
        if (ref.launch_generation)
          this.checkTerminal(ref, await this.json(["get", ref.terminal_ref]));
        yield {
          ok: true,
          value: {
            ...event,
            observations: event.observations.filter(
              (t) => t.terminal_ref === ref.terminal_ref,
            ),
          },
        };
      }
    } catch (error) {
      yield await result<RuntimeEvent>(async () => {
        throw error;
      });
    }
  }
  status(ref: RuntimeRef) {
    const key = JSON.stringify([
      ref.machine_id,
      ref.runtime_machine,
      ref.terminal_ref,
      ref.agent_name,
      ref.worktree_path,
      ref.branch,
      ref.agent_session_id,
      ref.target,
      ref.launch_generation,
      this.statusEpochs.get(ref.terminal_ref) ?? 0,
    ]);
    const pending = this.statusRequests.get(key);
    if (pending) return pending;
    const request = result(async () => {
      this.checkRef(ref);
      this.checkTerminal(ref, await this.json(["get", ref.terminal_ref]));
      // The shared source refresh starts after get. Existing consumers keep
      // their subscription and observe the new source's own sequence.
      const event = await this.hub.snapshot(Math.max(this.timeoutMs, 20_000));
      const found = event.observations.find(
        (t) => t.terminal_ref === ref.terminal_ref,
      );
      if (found) return found.status;
      fail("runtime_not_found", "Terminal is absent from the runtime snapshot");
    });
    this.statusRequests.set(key, request);
    void request.finally(() => {
      if (this.statusRequests.get(key) === request)
        this.statusRequests.delete(key);
    });
    return request;
  }
  async terminalActivity(
    ref: RuntimeRef,
    project: string,
    assignment: string,
  ): Promise<RuntimeResult<ReturnType<typeof terminalSnapshot>>> {
    try {
      this.checkRef(ref);
      const get = async () => {
        const t: Terminal = await this.json(["get", ref.terminal_ref]);
        this.checkTerminal(ref, t);
        if (
          t.address !== ref.terminal_ref ||
          t.state !== "live" ||
          t.labels?.project !== project ||
          t.labels.assignment !== assignment
        )
          throw new Error();
        return t;
      };
      const before = await get();
      const screen = await this.client.exec([
        "read",
        ref.terminal_ref,
        "--lines",
        "0",
      ]);
      const after = await get();
      if (
        JSON.stringify(before.labels) !== JSON.stringify(after.labels) ||
        before.created_ms !== after.created_ms
      )
        throw new Error();
      return {
        ok: true as const,
        value: terminalSnapshot(screen, after.foreground),
      };
    } catch {
      return {
        ok: false as const,
        error: {
          code: "runtime_unavailable" as const,
          message: "终端活动不可用",
        },
      };
    }
  }
  async interaction(
    ref: RuntimeRef,
    identity: { project_id: string; assignment_id: string; harness: string },
  ) {
    // All errors are replaced here: even an hc error containing screen text
    // must never enter result()'s general diagnostic-message path.
    try {
      this.checkRef(ref);
      const matches = (t: Terminal) => {
        this.checkTerminal(ref, t);
        return (
          t.address === ref.terminal_ref &&
          t.labels?.project === identity.project_id &&
          t.labels.assignment === identity.assignment_id
        );
      };
      const before: Terminal = await this.json(["get", ref.terminal_ref]);
      if (!matches(before)) throw new Error();
      if (before.state === "finished")
        return { ok: true as const, value: "exited" as const };
      if (before.state !== "live" || before.status?.state === "working")
        return { ok: true as const, value: "unknown" as const };
      if (identity.harness !== "codex")
        return {
          ok: true as const,
          value:
            before.status?.state === "blocked"
              ? ("blocked" as const)
              : ("unknown" as const),
        };
      const screen = await this.client.exec([
        "read",
        ref.terminal_ref,
        "--lines",
        "0",
      ]);
      const confirmation = confirmationVisible(screen);
      const after: Terminal = await this.json(["get", ref.terminal_ref]);
      if (
        !matches(after) ||
        JSON.stringify(before.labels) !== JSON.stringify(after.labels)
      )
        throw new Error();
      return {
        ok: true as const,
        value:
          after.state === "finished"
            ? ("exited" as const)
            : after.state !== "live" || after.status?.state === "working"
              ? ("unknown" as const)
              : confirmation
                ? ("confirmation" as const)
                : after.status?.state === "blocked"
                  ? ("blocked" as const)
                  : ("unknown" as const),
      };
    } catch {
      return {
        ok: false as const,
        error: {
          code: "runtime_unavailable" as const,
          message: "交互观察不可用",
        },
      };
    }
  }
  interrupt(ref: RuntimeRef) {
    return result(async () => {
      this.checkRef(ref);
      if (ref.launch_generation)
        this.checkTerminal(ref, await this.json(["get", ref.terminal_ref]));
      this.invalidateStatus(ref);
      try {
        await this.json(["interrupt", ref.terminal_ref, "--timeout", "2"]);
      } finally {
        this.invalidateStatus(ref);
      }
    });
  }
  resume_or_replace(ref: RuntimeRef, launch: RuntimeLaunch) {
    return result(async () => {
      this.checkRef(ref);
      this.checkLaunchEnabled();
      this.validateLaunch(launch);
      if (ref.worktree_path && ref.worktree_path !== launch.cwd)
        fail("invalid_launch", "Replacement must reuse the worktree");
      const released = await this.release(ref, { force: true });
      if (
        !released.ok &&
        released.error.code !== "runtime_not_found" &&
        !(
          released.error.code === "runtime_unavailable" &&
          !(await this.client.available())
        )
      )
        fail(released.error.code, released.error.message);
      const {
        agent_session_id: _previousSession,
        local_process_receipt: _oldReceipt,
        ...previous
      } = ref;
      return {
        ...previous,
        terminal_ref: await this.launch(
          { ...launch, labels: { ...launch.labels, cardigan: "1" } },
          true,
        ),
        agent_name: launch.agent_name,
        ...(launch.labels.generation
          ? {
              launch_generation: {
                run_id: launch.labels.run as import("@cardigan/domain").RunId,
                generation: launch.labels.generation,
              },
            }
          : {}),
      };
    });
  }
  /** One-shot process probe for human entry; no event subscription or sequence. */
  probeTerminal(ref: RuntimeRef) {
    return result<RuntimeObservation["process"]>(async () => {
      this.checkRef(ref);
      const terminal: Terminal = await this.json(["get", ref.terminal_ref]);
      this.checkTerminal(ref, terminal);
      return terminal.state === "live"
        ? "alive"
        : terminal.state === "finished"
          ? "exited"
          : "unknown";
    });
  }
  human_entry(ref: RuntimeRef) {
    return result(async () => {
      this.checkRef(ref);
      if (this.execution.mode === "agent-ssh") await this.live();
      return `HC_SESSION=${quote(this.session)} HC_SOCKET=${quote(this.socketPath)} ${quote(this.binary)} attach ${quote(ref.terminal_ref)}`;
    });
  }
  release(ref: RuntimeRef, options: { readonly force: boolean }) {
    return result(async () => {
      this.checkRef(ref);
      this.invalidateStatus(ref);
      try {
        const terminal: Terminal = await this.json(["get", ref.terminal_ref]);
        this.checkTerminal(ref, terminal);
        if (
          !options.force &&
          ["working", "blocked"].includes(terminal.status?.state ?? "")
        )
          fail("runtime_conflict", "Terminal is busy; force is required");
        if (terminal.state === "live")
          await this.json(["kill", ref.terminal_ref]);
        await this.json(["rm", ref.terminal_ref]);
      } finally {
        this.invalidateStatus(ref);
      }
    });
  }

  private checkRetirementTerminal(
    ref: RuntimeRef,
    identity: RetirementIdentity,
    terminal: Terminal,
  ) {
    this.checkTerminal(ref, terminal);
    if (
      terminal.address !== ref.terminal_ref ||
      terminal.labels?.project !== identity.project_id ||
      terminal.labels?.assignment !== identity.assignment_id ||
      (!ref.launch_generation && terminal.labels.generation !== undefined)
    )
      fail("runtime_conflict", "Idle terminal identity changed");
  }
  /** The loopback relay can report a live address without the worker's owner
   * labels. Inspect the same managed socket/account as worker diagnostics.
   * Return only the fixed terminal projection, never a screen or controller PID. */
  private async retirementTerminal(
    ref: RuntimeRef,
    owner: RetirementIdentity,
    raw?: Pick<HcClient, "exec">,
  ): Promise<Terminal> {
    const execution = this.execution;
    if (managedLoopback(execution) && ref.machine_id === "local") {
      if (
        ref.target?.project_id !== owner.project_id ||
        ref.target?.session !== this.session
      )
        fail("runtime_conflict", "Loopback binding changed");
      const run = ref.launch_generation?.run_id ?? owner.first_bell_run_id;
      if (!run) fail("runtime_conflict", "Missing bound worker launch Run");
      const terminal = ref.terminal_ref.slice(execution.machine.length + 1);
      const t: Terminal = await loopbackTerminal(execution, {
        project: owner.project_id,
        assignment: owner.assignment_id,
        launch_run: run,
        generation: ref.launch_generation?.generation ?? null,
        terminal,
        session: this.session,
      });
      if (
        t.address !== terminal ||
        t.labels?.cardigan !== "1" ||
        t.labels.run !== run ||
        !["live", "finished"].includes(t.state) ||
        !Number.isSafeInteger(t.created_ms) ||
        (t.state === "live" &&
          (!Number.isSafeInteger(t.pid) || (t.pid ?? 0) <= 1))
      )
        fail("runtime_conflict", "Unconfirmed worker terminal");
      return { ...t, address: ref.terminal_ref };
    }
    return raw
      ? JSON.parse(await raw.exec(["get", ref.terminal_ref, "--json"]))
      : this.json(["get", ref.terminal_ref]);
  }
  observe_retirement(
    ref: RuntimeRef,
    identity: RetirementIdentity & { readonly system_finished_turn?: true },
  ): Promise<RuntimeResult<RuntimeObservation["process"]>> {
    return result(async () => {
      this.checkRef(ref);
      if (this.execution.mode === "agent-ssh" && this.execution.macosCore) {
        const observed = await darwinRetirementObservation(
          this.execution,
          ref,
          identity,
        );
        return observed === "kept" ? "unknown" : observed;
      }
      const terminal: Terminal = identity.system_finished_turn
        ? await this.retirementTerminal(ref, identity)
        : await this.json(["get", ref.terminal_ref]);
      this.checkRetirementTerminal(ref, identity, terminal);
      if (
        identity.system_finished_turn &&
        terminal.state === "live" &&
        (terminal.keep ||
          !["unknown", "idle", "done"].includes(
            terminal.status?.state ?? "unknown",
          ))
      )
        return "unknown";
      return terminal.state === "finished"
        ? "exited"
        : terminal.state === "live"
          ? "alive"
          : "unknown";
    });
  }
  async retire_idle(
    ref: RuntimeRef,
    options: Parameters<NonNullable<Runtime["retire_idle"]>>[1],
  ): Promise<RuntimeResult<IdleRetirementResult>> {
    let attempted = false;
    let stage: RetirementEvidence["stage"] = "target";
    let reason: RetirementEvidence["reason"] = "hc_failed";
    let state: RetirementEvidence["terminal_state"];
    const failure = (
      outcome: "uncertain" | "timeout" | "withdrawn",
      why: RetirementEvidence["reason"],
      details: Partial<RetirementEvidence> = {},
    ): RuntimeResult<IdleRetirementResult> => ({
      ok: true,
      value: {
        outcome,
        evidence: {
          stage,
          reason: why,
          ...(state ? { terminal_state: state } : {}),
          ...details,
        },
      },
    });
    const exited = { ok: true, value: { outcome: "exited" } } as const;
    try {
      this.checkRef(ref);
      for (const ms of [options.hangup_ms, options.terminate_ms])
        if (!Number.isSafeInteger(ms) || ms < 1 || ms > 30_000)
          fail("invalid_launch", "Invalid idle retirement timeout");
      if (this.execution.mode === "agent-ssh" && this.execution.macosCore) {
        stage = "probe";
        const observed = await darwinRetirementObservation(
          this.execution,
          ref,
          options,
        );
        if (observed === "exited") return exited;
        if (observed === "kept") return failure("withdrawn", "kept_terminal");
        const stop = await stopDarwinOwner(this.execution, ref, options);
        if (stop.outcome === "uncertain") {
          // SSH receipt (or loss of it) is never exit. On timeout the next
          // patrol observes only, retaining the stop fence without resending.
          stage = "confirm";
          attempted = true;
          this.invalidateStatus(ref);
          const deadline = Date.now() + options.terminate_ms;
          do {
            if (
              (await darwinRetirementObservation(
                this.execution,
                ref,
                options,
              )) === "exited"
            )
              return exited;
            if (Date.now() >= deadline) break;
            await delay(Math.min(250, deadline - Date.now()));
          } while (Date.now() <= deadline);
        }
        return { ok: true, value: stop };
      }
      stage = "get";
      const readTerminal = () =>
        options.system_finished_turn
          ? this.retirementTerminal(ref, options)
          : this.json(["get", ref.terminal_ref]);
      const first: Terminal = await readTerminal();
      const check = (terminal: Terminal) => {
        state =
          terminal.state === "live" || terminal.state === "finished"
            ? terminal.state
            : "other";
        this.checkRetirementTerminal(ref, options, terminal);
        if (terminal.created_ms !== first.created_ms)
          fail("runtime_conflict", "Idle terminal identity changed");
      };
      check(first);
      if (first.state === "finished") return exited;
      // A kept terminal can replace a signalled program with a shell. Do not
      // silently change that policy or mistake the shell for the retired CLI.
      if (first.keep) return failure("withdrawn", "kept_terminal");
      if (first.state !== "live")
        return failure("withdrawn", "terminal_not_live");
      if (!Number.isSafeInteger(first.pid) || (first.pid ?? 0) <= 1)
        return failure("withdrawn", "missing_pid");
      if (!Number.isSafeInteger(first.created_ms))
        return failure("withdrawn", "missing_creation_time");
      const address = ref.terminal_ref.split("/").at(-1)!;
      const exec = (mode: string, identity?: string) => [
        "exec",
        ...(this.execution.mode === "agent-ssh"
          ? ["--on", this.execution.machine]
          : []),
        "--",
        "python3",
        "-I",
        "-c",
        idleRetirementHelper,
        mode,
        String(first.pid),
        address,
        ...(identity ? [identity] : []),
      ];
      stage = "probe";
      // A direct worker observation does not itself authorize the relay used
      // by the pidfd helper. Revalidate its registration before the probe.
      if (options.system_finished_turn && managedLoopback(this.execution))
        await this.live();
      const raw = await this.client.exec(exec("probe"));
      reason = "probe_invalid";
      const identity = JSON.parse(raw);
      if (
        identity.pid !== first.pid ||
        typeof identity.start !== "string" ||
        typeof identity.boot !== "string" ||
        !Number.isSafeInteger(identity.uid)
      )
        return failure("withdrawn", "probe_invalid");
      const expected = options.system_finished_turn && options.expected_process;
      if (
        expected &&
        (identity.pid !== expected.pid ||
          identity.boot !== expected.boot ||
          identity.start !== expected.start ||
          identity.uid !== expected.uid ||
          identity.group !== expected.process_group ||
          expected.machine !== ref.target?.fingerprint ||
          expected.terminal !== ref.launch_generation?.generation)
      )
        return failure("withdrawn", "identity_changed");
      reason = "hc_failed";
      const hasExited = (terminal: Terminal) => {
        check(terminal);
        if (terminal.state === "finished") return true;
        if (
          terminal.state !== "live" ||
          terminal.pid !== first.pid ||
          terminal.keep
        )
          fail("runtime_conflict", "Idle terminal process changed");
        return false;
      };
      const inspect = async () => {
        stage = "confirm";
        return hasExited(await readTerminal());
      };
      const wait = async (ms: number) => {
        const until = Date.now() + ms;
        do {
          if (await inspect()) return true;
          if (Date.now() >= until) break;
          await delay(Math.min(250, until - Date.now()));
        } while (Date.now() < until);
        return inspect();
      };
      this.invalidateStatus(ref);
      try {
        for (const [mode, budget] of [
          ["HUP", options.hangup_ms],
          ["TERM", options.terminate_ms],
        ] as const) {
          if (options.system_finished_turn && mode === "HUP") continue;
          if (await inspect()) return exited;
          stage = mode;
          let refused: RetirementEvidence["reason"] = "guard_changed";
          // The queue's guard runs after all waits and immediately before IO.
          if (
            !(await this.client.execIfCurrent(
              exec(mode, JSON.stringify(identity)),
              () => {
                if (!options.before_signal()) return false;
                attempted = true;
                return true;
              },
              options.system_finished_turn
                ? async (raw) => {
                    // Inside the acquired signal slot. Even if the address is reused
                    // after this read, the helper can only signal the probed pidfd.
                    if (!(await options.workspace_preflight())) return false;
                    const target = await this.retirementTerminal(
                      ref,
                      options,
                      raw,
                    );
                    if (hasExited(target)) {
                      refused = "terminal_not_live";
                      return false;
                    }
                    if (
                      !["idle", "done", "unknown"].includes(
                        target.status?.state ?? "unknown",
                      )
                    ) {
                      refused = "terminal_busy";
                      return false;
                    }
                    return true;
                  }
                : undefined,
            ))
          )
            return failure(attempted ? "uncertain" : "withdrawn", refused);
          if (await wait(budget)) return exited;
        }
        return failure("timeout", "still_live");
      } finally {
        this.invalidateStatus(ref);
      }
    } catch (error) {
      const err = error instanceof RuntimeFailure ? error : undefined;
      const code = err?.detail?.exit_code;
      const helperReasons: Partial<
        Record<number, RetirementEvidence["reason"]>
      > = {
        2: "probe_invalid",
        20: "pidfd_unavailable",
        21: "permission_denied",
        22: "marker_mismatch",
        23: "process_gone",
        24: "identity_changed",
      };
      const helper = stage === "probe" || stage === "HUP" || stage === "TERM";
      const why =
        helper && code !== undefined
          ? (helperReasons[code] ?? reason)
          : !err?.hcKind &&
              (err?.code === "runtime_conflict" ||
                err?.code === "invalid_launch")
            ? "identity_changed"
            : reason;
      return failure(attempted ? "uncertain" : "withdrawn", why, {
        ...(err ? { runtime_code: err.code } : {}),
        ...(err?.hcKind ? { hc_kind: err.hcKind } : {}),
        ...(code !== undefined &&
        Number.isInteger(code) &&
        code >= 0 &&
        code <= 255
          ? { exit_code: code }
          : {}),
      });
    }
  }
}

export {
  type WorkerGitOperation,
  type WorkerGitRequest,
  workerGit,
  workerGitCommand,
  workerGitFailure,
  workerGitPack,
} from "./worker-git.js";
