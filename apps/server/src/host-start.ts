import type {
  Actor,
  Assignment,
  Clock,
  DispatchRunParams,
  ProjectId,
  Run,
  Runtime,
} from "@cardigan/domain";
import {
  type LaunchHost,
  launchRun,
  type MachineLeases,
  projectActor,
  type ResourceAccess,
} from "@cardigan/host";
import type { LaunchConfig } from "@cardigan/roles";
import type { ExecutionConfig } from "@cardigan/runtime-herdr";
import type { Store } from "@cardigan/store";

/**
 * M3.5 host adapter: start a terminal for a Run the Dispatcher already queued.
 *
 * The Dispatcher decides *who* to wake and *what* the bell says. Opening the
 * terminal is the same flow as `cardigan assignment start` (M2 plan §4 steps
 * 3–9), so this module only supplies the server's facts — a system actor and a
 * bell as the first prompt — and delegates to `@cardigan/host`'s `launchRun`.
 * It never queues a Run.
 */
export interface StartRunHost {
  readonly configDir?: string;
  readonly store: Store;
  readonly runtime: Runtime;
  readonly launch: {
    readonly config: LaunchConfig;
    readonly secrets: Readonly<Record<string, string>>;
  };
  readonly mcpUrl: string;
  /** C-600: refuse and rebuild sessions whose harness never listed Card tools. */
  readonly verifyMcpSession?: boolean;
  readonly dataDir: string;
  readonly execution?: ExecutionConfig;
  readonly clock?: Clock;
}

export interface StartRunInput {
  readonly project: ProjectId;
  readonly assignment: Assignment;
  readonly run: Run;
  readonly bell: string;
  readonly resourceAccess?: ResourceAccess;
  readonly resourcePreflight?: () => Promise<boolean>;
  readonly resourceGate?: () => boolean;
  readonly replacement?: DispatchRunParams["replacement"];
  /**
   * C-834: the Dispatcher's leases. Without them the launch cannot read the
   * adb slot and devices this Run holds, so its session would get none of
   * their environment and keep a worker's fixed adb port.
   */
  readonly leases?: MachineLeases;
}

const hostActor = (project: ProjectId): Actor =>
  projectActor("system", project);

/**
 * Start and dispatch `input.run`. Throws after compensating when any step
 * fails; the Dispatcher treats a thrown error as `delivery_call_failed`.
 */
export async function startQueuedRun(
  host: StartRunHost,
  input: StartRunInput,
): Promise<void> {
  const launchHost: LaunchHost = {
    ...(host.configDir === undefined ? {} : { configDir: host.configDir }),
    store: host.store,
    runtime: host.runtime,
    launch: host.launch,
    mcpUrl: host.mcpUrl,
    ...(host.verifyMcpSession ? { verifyMcpSession: true } : {}),
    dataDir: host.dataDir,
    ...(host.execution === undefined ? {} : { execution: host.execution }),
    ...(host.clock === undefined ? {} : { clock: host.clock }),
    ...(input.leases ? { leases: input.leases } : {}),
  };
  await launchRun(launchHost, {
    project: input.project,
    assignment_id: input.assignment.id,
    run: input.run,
    actor: hostActor(input.project),
    ...(input.resourceAccess ? { resourceAccess: input.resourceAccess } : {}),
    ...(input.resourcePreflight
      ? { resourcePreflight: input.resourcePreflight }
      : {}),
    ...(input.resourceGate ? { resourceGate: input.resourceGate } : {}),
    first_prompt: input.bell,
    retry_target_preflight: true,
    ...(input.replacement ? { replacement: input.replacement } : {}),
  });
}
