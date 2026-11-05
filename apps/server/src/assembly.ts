import type {
  AssignmentId,
  Clock,
  CommandState,
  ProjectId,
} from "@cardigan/domain";
import { type Store, tokensForAssignment } from "@cardigan/store";
import { Dispatcher, type DispatcherOptions } from "./dispatch.js";
import { dispatcherClock, type StandingResolver } from "./dispatch-inbox.js";
import {
  type DispatchLoop,
  type DispatchLoopOptions,
  startDispatchLoop,
} from "./dispatch-loop.js";
import {
  RuntimeMonitor,
  type RuntimeMonitorOptions,
} from "./dispatch-monitor.js";
import type { MergeGit } from "./git.js";
import { type MergeExecutor, startMergeLoop } from "./merge-loop.js";

/**
 * M3.5: the control plane the server runs beside the MCP endpoint.
 *
 * The Store, Runtime and MCP endpoint are owned by the caller; this module only
 * owns the loops, so shutdown order stays explicit:
 * `stop()` (loop + monitor drain) → close the MCP endpoint → close the Store.
 */
export interface ControlPlaneOptions {
  readonly store: Store;
  readonly runtime: DispatcherOptions["runtime"] &
    RuntimeMonitorOptions["runtime"];
  readonly snapshot: DispatcherOptions["snapshot"];
  readonly startRun: DispatcherOptions["startRun"];
  readonly standing?: StandingResolver;
  readonly clock?: Clock;
  readonly intervalMs?: number;
  readonly deliveryLeaseMs?: number;
  readonly retryBaseMs?: number;
  readonly maxRetries?: number;
  readonly inactivityGraceMs?: number;
  readonly lossGraceMs?: number;
  readonly eventSilenceMs?: number;
  /**
   * M4.4: present when the host wired Git. Without it no merge can run, which
   * is what tests of the pure dispatcher want.
   */
  readonly git?: MergeGit;
  readonly mergeIntervalMs?: number;
  /** Tick failures are reported here; the loop retries on the next interval. */
  readonly onError?: (error: unknown) => void;
}

export interface ControlPlane {
  readonly done: Promise<void>;
  /** The merge loop, for tests and for status output. */
  readonly merge?: MergeExecutor;
  /**
   * Stop scheduling, drain the current delivery, then stop the monitor; the
   * merge loop stops last so SIGTERM never interrupts a merge (§4 M4.4).
   */
  stop(): Promise<void>;
}

/**
 * PM Office / Ops are the standing pm Assignments whose newest token tells them
 * apart. The lookup runs on plain queries of the shared connection: it is also
 * called from inside a Dispatcher transaction, where opening another UnitOfWork
 * would fail.
 */
export function standingResolver(
  store: Store,
  tokensOf: (
    project: ProjectId,
    assignment: AssignmentId,
  ) => readonly { readonly allowed_tools: readonly string[] }[] = (
    project,
    assignment,
  ) =>
    tokensForAssignment(store.database, project, assignment).map((token) => ({
      allowed_tools: token.allowed_tools,
    })),
): StandingResolver {
  return (
    project: ProjectId,
    kind: "pm_ops" | "pm_office",
    state: CommandState,
  ): AssignmentId | undefined => {
    const wantOffice = kind === "pm_office";
    for (const candidate of state.assignments) {
      if (
        candidate.scope !== "standing" ||
        candidate.role_id !== "pm" ||
        candidate.status !== "active"
      )
        continue;
      const tools = tokensOf(project, candidate.id).at(-1)?.allowed_tools ?? [];
      if (tools.includes("record_decision") === wantOffice) return candidate.id;
    }
    return undefined;
  };
}

export function startControlPlane(options: ControlPlaneOptions): ControlPlane {
  const clock = options.clock ?? dispatcherClock;
  const standing = options.standing ?? standingResolver(options.store);
  const dispatcher = new Dispatcher({
    store: options.store,
    runtime: options.runtime,
    clock,
    standing,
    snapshot: options.snapshot,
    startRun: options.startRun,
    ...(options.deliveryLeaseMs === undefined
      ? {}
      : { deliveryLeaseMs: options.deliveryLeaseMs }),
    ...(options.retryBaseMs === undefined
      ? {}
      : { retryBaseMs: options.retryBaseMs }),
    ...(options.maxRetries === undefined
      ? {}
      : { maxRetries: options.maxRetries }),
    ...(options.inactivityGraceMs === undefined
      ? {}
      : { inactivityGraceMs: options.inactivityGraceMs }),
  });
  const monitor = new RuntimeMonitor({
    store: options.store,
    runtime: options.runtime,
    clock,
    standing,
    ...(options.lossGraceMs === undefined
      ? {}
      : { lossGraceMs: options.lossGraceMs }),
    ...(options.eventSilenceMs === undefined
      ? {}
      : { eventSilenceMs: options.eventSilenceMs }),
  });
  const loopOptions: DispatchLoopOptions = {
    dispatcher,
    monitor,
    ...(options.intervalMs === undefined
      ? {}
      : { intervalMs: options.intervalMs }),
    onError: (error) => options.onError?.(error),
  };
  const loop: DispatchLoop = startDispatchLoop(loopOptions);
  const merge =
    options.git === undefined
      ? undefined
      : startMergeLoop({
          store: options.store,
          git: options.git,
          clock,
          ...(options.mergeIntervalMs === undefined
            ? {}
            : { intervalMs: options.mergeIntervalMs }),
          onError: (error) => options.onError?.(error),
        });
  return {
    done:
      merge === undefined
        ? loop.done
        : Promise.all([loop.done, merge.loop.done]).then(() => undefined),
    ...(merge === undefined ? {} : { merge: merge.executor }),
    stop: async () => {
      await loop.stop();
      await merge?.loop.stop();
    },
  };
}
