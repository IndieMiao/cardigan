import type {
  Actor,
  Assignment,
  Clock,
  ProjectId,
  Run,
  Runtime,
} from "@cardigan/domain";
import { type LaunchHost, launchRun, projectActor } from "@cardigan/host";
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
  readonly store: Store;
  readonly runtime: Runtime;
  readonly launch: {
    readonly config: LaunchConfig;
    readonly secrets: Readonly<Record<string, string>>;
  };
  readonly mcpUrl: string;
  readonly dataDir: string;
  readonly execution?: ExecutionConfig;
  readonly clock?: Clock;
}

export interface StartRunInput {
  readonly project: ProjectId;
  readonly assignment: Assignment;
  readonly run: Run;
  readonly bell: string;
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
    store: host.store,
    runtime: host.runtime,
    launch: host.launch,
    mcpUrl: host.mcpUrl,
    dataDir: host.dataDir,
    ...(host.execution === undefined ? {} : { execution: host.execution }),
    ...(host.clock === undefined ? {} : { clock: host.clock }),
  };
  await launchRun(launchHost, {
    project: input.project,
    assignment_id: input.assignment.id,
    run: input.run,
    actor: hostActor(input.project),
    first_prompt: input.bell,
  });
}
