import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { idleRetirementHelper } from "./idle-retirement.js";

export * from "./check-recovery.js";
export * from "./worker-capabilities.js";
export * from "./worker-files.js";
export * from "./worker-preflight.js";
export * from "./worker-primitives.js";

import { join } from "node:path";
import type {
  Assignment,
  Machine,
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
import { registerAgentMachine } from "./agent-ssh.js";
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
  readonly execution?: ExecutionConfig;
  readonly binary?: string;
  readonly session?: string;
  readonly socketPath?: string;
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
  private constructor(
    readonly session: string,
    readonly socketPath: string,
    private binary: string,
    private client: GovernedHcClient,
    private execution: ExecutionConfig,
    private timeoutMs: number,
    private version: string,
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
      const version = options.version ?? "0.1.18";
      if ((await client.exec(["--version"])).trim() !== `hc ${version}`)
        fail("version_mismatch", "Unsupported hc version");
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
    if (this.execution.target && this.execution.target.machine_id !== "local")
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
    return launched.address as string;
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
          ...launch,
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
      return ref;
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
  wake(ref: RuntimeRef, doorbell: string, options?: RuntimeWakeOptions) {
    return result<RuntimeWakeResult>(async () => {
      this.checkRef(ref);
      this.checkLaunchEnabled();
      await this.live();
      if (ref.launch_generation)
        this.checkTerminal(ref, await this.json(["get", ref.terminal_ref]));
      this.invalidateStatus(ref);
      try {
        const sent = await this.client.execIfCurrent(
          [
            "send",
            "--json",
            ...(options?.if_idle ? ["--if", "idle"] : []),
            "--",
            ref.terminal_ref,
            doorbell,
          ],
          options?.before_send ?? (() => true),
        );
        return sent ? { sent: true } : { sent: false, withdrawn: true };
      } finally {
        this.invalidateStatus(ref);
      }
    });
  }
  /** Host orchestration only: run Git or inspect an installed Agent CLI as agent. */
  async captureAgent(
    command: "git" | "claude" | "codex" | "pi",
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
        !["git", "claude", "codex", "pi"].includes(command)
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
      const { agent_session_id: _previousSession, ...previous } = ref;
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

  async retire_idle(
    ref: RuntimeRef,
    options: Parameters<NonNullable<Runtime["retire_idle"]>>[1],
  ) {
    let attempted = false;
    const retired = await result(async () => {
      this.checkRef(ref);
      for (const ms of [options.hangup_ms, options.terminate_ms])
        if (!Number.isSafeInteger(ms) || ms < 1 || ms > 30_000)
          fail("invalid_launch", "Invalid idle retirement timeout");
      const first: Terminal = await this.json(["get", ref.terminal_ref]);
      const check = (terminal: Terminal) => {
        this.checkTerminal(ref, terminal);
        if (
          terminal.labels?.project !== options.project_id ||
          terminal.labels?.assignment !== options.assignment_id ||
          terminal.address !== first.address ||
          terminal.created_ms !== first.created_ms
        )
          fail("runtime_conflict", "Idle terminal identity changed");
      };
      check(first);
      if (first.state === "finished") return { exited: true };
      // A kept terminal can replace a signalled program with a shell. Do not
      // silently change that policy or mistake the shell for the retired CLI.
      if (
        first.keep ||
        first.state !== "live" ||
        !Number.isSafeInteger(first.pid) ||
        (first.pid ?? 0) <= 1 ||
        !Number.isSafeInteger(first.created_ms)
      )
        fail(
          "runtime_conflict",
          "Idle terminal process identity is unavailable",
        );
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
      const identity = JSON.parse(await this.client.exec(exec("probe")));
      if (
        identity.pid !== first.pid ||
        typeof identity.start !== "string" ||
        typeof identity.boot !== "string" ||
        !Number.isSafeInteger(identity.uid)
      )
        fail("runtime_conflict", "Idle process observation is invalid");
      const inspect = async () => {
        const terminal: Terminal = await this.json(["get", ref.terminal_ref]);
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
      const wait = async (ms: number) => {
        const until = Date.now() + ms;
        do {
          if (await inspect()) return true;
          if (Date.now() >= until) break;
          await delay(Math.min(250, until - Date.now()));
        } while (Date.now() < until);
        return inspect();
      };
      let signalled = false;
      this.invalidateStatus(ref);
      try {
        for (const [mode, budget] of [
          ["HUP", options.hangup_ms],
          ["TERM", options.terminate_ms],
        ] as const) {
          if (await inspect()) return { exited: true };
          // The queue's guard runs after all waits and immediately before IO.
          if (
            !(await this.client.execIfCurrent(
              exec(mode, JSON.stringify(identity)),
              () => {
                if (!options.before_signal()) return false;
                attempted = true;
                return true;
              },
            ))
          )
            return {
              exited: false,
              ...(!signalled ? { withdrawn: true } : {}),
            };
          signalled = true;
          if (await wait(budget)) return { exited: true };
        }
        return { exited: false };
      } finally {
        this.invalidateStatus(ref);
      }
    });
    return !retired.ok && !attempted
      ? { ok: true as const, value: { exited: false, withdrawn: true } }
      : retired;
  }
}
