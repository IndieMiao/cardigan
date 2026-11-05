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
  /** Tick failures are reported here; the loop retries on the next interval. */
  readonly onError?: (error: unknown) => void;
}

export interface ControlPlane {
  readonly done: Promise<void>;
  /** Stop scheduling, drain the current delivery, then stop the monitor. */
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
  return { done: loop.done, stop: () => loop.stop() };
}
