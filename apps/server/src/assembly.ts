import type {
  AssignmentId,
  Clock,
  CommandState,
  ProjectId,
} from "@cardigan/domain";
import { standingModeFromTools } from "@cardigan/domain";
import type { LaunchConfig } from "@cardigan/roles";
import { type Store, tokensForAssignment } from "@cardigan/store";
import { type AttachmentGc, startAttachmentLoop } from "./attachment-loop.js";
import { type CleanupExecutor, startCleanupLoop } from "./cleanup-loop.js";
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
import type { GitPhases } from "./git.js";
import type { MergeCheckOptions } from "./merge-checks.js";
import { type MergeExecutor, startMergeLoop } from "./merge-loop.js";
import {
  type MergePushExecutor,
  startMergePushLoop,
} from "./merge-push-loop.js";
import { MergeShadowObserver } from "./merge-shadow.js";
import {
  type BackupExecutor,
  type ReconcileExecutor,
  startBackupLoop,
  startReconcileLoop,
} from "./reconcile-loop.js";

/**
 * M3.5: the control plane the server runs beside the MCP endpoint.
 *
 * The Store, Runtime and MCP endpoint are owned by the caller; this module only
 * owns the loops, so shutdown order stays explicit:
 * `stop()` (loop + monitor drain) → close the MCP endpoint → close the Store.
 */
export interface ControlPlaneOptions {
  readonly upstream?: LaunchConfig;
  readonly hostOpsTick?: () => Promise<void>;
  readonly hostOpsPatrolIntervalMs?: number;
  readonly store: Store;
  readonly runtime: DispatcherOptions["runtime"] &
    RuntimeMonitorOptions["runtime"];
  readonly snapshot: DispatcherOptions["snapshot"];
  readonly toolCatalog?: DispatcherOptions["toolCatalog"];
  readonly runLimit?: DispatcherOptions["runLimit"];
  readonly runLimitMaximum?: DispatcherOptions["runLimitMaximum"];
  readonly startRun: DispatcherOptions["startRun"];
  readonly recoverLaunches?: DispatcherOptions["recoverLaunches"];
  readonly beforeWake?: DispatcherOptions["beforeWake"];
  readonly standing?: StandingResolver;
  readonly clock?: Clock;
  readonly intervalMs?: number;
  readonly deliveryLeaseMs?: number;
  readonly retryBaseMs?: number;
  readonly maxRetries?: number;
  readonly inactivityGraceMs?: number;
  readonly dispatchTimeoutMs?: number;
  readonly deliveryRetryBaseMs?: number;
  readonly inactiveCancelAfterMs?: number | null;
  readonly lossGraceMs?: number;
  readonly eventSilenceMs?: number;
  readonly runtimeFailureLimit?: number;
  /** C-228 / Q-387: failures-only unknown grace before Needs You. */
  readonly runtimeUnknownGraceMs?: number;
  /**
   * M4.4: present when the host wired Git. Without it no merge can run, which
   * is what tests of the pure dispatcher want.
   */
  readonly git?: GitPhases;
  readonly mergeGate?: MergeCheckOptions;
  readonly mergeIntervalMs?: number;
  readonly cleanupIntervalMs?: number;
  readonly reconcileIntervalMs?: number;
  readonly backupIntervalMs?: number;
  /**
   * Data directory holding `attachments/`. Without it the blob GC has nothing
   * to sweep, so the loop only starts when the caller passes it.
   */
  readonly dataDir?: string;
  readonly attachmentIntervalMs?: number;
  /** Tick failures are reported here; the loop retries on the next interval. */
  readonly onError?: (error: unknown) => void;
}

export interface ControlPlane {
  readonly done: Promise<void>;
  /** The phase loops, exposed for tests and for status output. */
  readonly merge?: MergeExecutor;
  readonly push?: MergePushExecutor;
  readonly cleanup?: CleanupExecutor;
  readonly reconcile?: ReconcileExecutor;
  readonly backup?: BackupExecutor;
  readonly attachments?: AttachmentGc;
  /**
   * Stop scheduling, drain the current delivery, then stop the monitor; the
   * Git phase loops stop in a fixed order so SIGTERM never interrupts a merge
   * (§4 M4.4), and the attachment sweep stops last.
   */
  stop(): Promise<void>;
}

/**
 * M4.5 (§7.1, §10.4): PM Office and PM Ops are the standing pm Assignments with
 * `standing_mode` office / ops. The field is written once by `cardigan pm
 * create` and backfilled for older rows at startup, so routing never has to
 * guess from a token again. The token lookup stays as a read-only fallback for
 * a legacy row that a dispatcher tick sees before the startup backfill.
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
    const want = kind === "pm_office" ? "office" : "ops";
    for (const candidate of state.assignments) {
      if (
        candidate.scope !== "standing" ||
        candidate.role_id !== "pm" ||
        candidate.status !== "active"
      )
        continue;
      // C-244: read tokens only for a legacy row without standing_mode; the
      // token query scans the whole tokens table.
      const newest =
        candidate.standing_mode === undefined
          ? tokensOf(project, candidate.id).at(-1)
          : undefined;
      const mode =
        candidate.standing_mode ??
        (newest === undefined
          ? undefined
          : standingModeFromTools(newest.allowed_tools));
      if (mode === want) return candidate.id;
    }
    return undefined;
  };
}

export function startControlPlane(options: ControlPlaneOptions): ControlPlane {
  const clock = options.clock ?? dispatcherClock;
  const standing = options.standing ?? standingResolver(options.store);
  const shadow = new MergeShadowObserver(options.store, options.git, clock);
  const dispatcher = new Dispatcher({
    ...(options.git?.proveReviewLimit
      ? { proveReviewLimit: options.git.proveReviewLimit.bind(options.git) }
      : {}),
    mergeShadowTick: (project) => shadow.tick(project),
    ...(options.hostOpsTick ? { hostOpsTick: options.hostOpsTick } : {}),
    ...(options.hostOpsPatrolIntervalMs === undefined
      ? {}
      : { hostOpsPatrolIntervalMs: options.hostOpsPatrolIntervalMs }),
    store: options.store,
    runtime: options.runtime,
    clock,
    standing,
    snapshot: options.snapshot,
    ...(options.toolCatalog ? { toolCatalog: options.toolCatalog } : {}),
    ...(options.inactiveCancelAfterMs === undefined
      ? {}
      : { inactiveCancelAfterMs: options.inactiveCancelAfterMs }),
    ...(options.runLimit ? { runLimit: options.runLimit } : {}),
    ...(options.runLimitMaximum
      ? { runLimitMaximum: options.runLimitMaximum }
      : {}),
    startRun: options.startRun,
    ...(options.recoverLaunches
      ? { recoverLaunches: options.recoverLaunches }
      : {}),
    ...(options.dispatchTimeoutMs === undefined
      ? {}
      : { dispatchTimeoutMs: options.dispatchTimeoutMs }),
    ...(options.deliveryRetryBaseMs === undefined
      ? {}
      : { deliveryRetryBaseMs: options.deliveryRetryBaseMs }),
    ...(options.beforeWake ? { beforeWake: options.beforeWake } : {}),
    onError: (error) => options.onError?.(error),
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
    ...(options.intervalMs === undefined
      ? {}
      : { reconcileIntervalMs: options.intervalMs }),
    ...(options.runtimeFailureLimit === undefined
      ? {}
      : { maxConsecutiveFailures: options.runtimeFailureLimit }),
    ...(options.runtimeUnknownGraceMs === undefined
      ? {}
      : { runtimeUnknownGraceMs: options.runtimeUnknownGraceMs }),
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
    onSlowTick: (durationMs) =>
      options.onError?.(
        new Error(
          `dispatcher slow tick: duration_ms=${durationMs} threshold_ms=1000`,
        ),
      ),
    ...(options.intervalMs === undefined
      ? {}
      : { intervalMs: options.intervalMs }),
    onError: (error) => options.onError?.(error),
  };
  const loop: DispatchLoop = startDispatchLoop(loopOptions);
  const report = (error: unknown) => options.onError?.(error);
  const merge =
    options.git === undefined
      ? undefined
      : startMergeLoop({
          store: options.store,
          git: options.git,
          clock,
          ...(options.mergeGate ? { gate: options.mergeGate } : {}),
          ...(options.mergeIntervalMs === undefined
            ? {}
            : { intervalMs: options.mergeIntervalMs }),
          onError: report,
          report: (message) => options.onError?.(new Error(message)),
        });
  const push =
    options.git && options.mergeGate
      ? startMergePushLoop({
          store: options.store,
          git: options.git,
          configuration: options.mergeGate.configuration,
          clock,
          onError: report,
          ...(options.mergeIntervalMs === undefined
            ? {}
            : { intervalMs: options.mergeIntervalMs }),
        })
      : undefined;
  const cleanup =
    options.git === undefined
      ? undefined
      : startCleanupLoop({
          store: options.store,
          git: options.git,
          runtime: options.runtime,
          clock,
          ...(options.cleanupIntervalMs === undefined
            ? {}
            : { intervalMs: options.cleanupIntervalMs }),
          onError: report,
          report: (message) => options.onError?.(new Error(message)),
        });
  const reconcile =
    options.git === undefined
      ? undefined
      : startReconcileLoop({
          store: options.store,
          git: options.git,
          clock,
          ...(options.reconcileIntervalMs === undefined
            ? {}
            : { intervalMs: options.reconcileIntervalMs }),
          onError: report,
          report: (message) => options.onError?.(new Error(message)),
        });
  const backup =
    options.git === undefined
      ? undefined
      : startBackupLoop({
          store: options.store,
          git: options.git,
          clock,
          ...(options.backupIntervalMs === undefined
            ? {}
            : { intervalMs: options.backupIntervalMs }),
          onError: report,
          report: (message) => options.onError?.(new Error(message)),
        });
  // Orphaned content-addressed blobs (§9.3) are host housekeeping, not Git work:
  // the sweep runs even when the host wired no Git.
  const attachments =
    options.dataDir === undefined
      ? undefined
      : startAttachmentLoop({
          dataDir: options.dataDir,
          store: options.store,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
          ...(options.attachmentIntervalMs === undefined
            ? {}
            : { intervalMs: options.attachmentIntervalMs }),
          onError: report,
        });
  const loops = [
    loop.done,
    merge?.loop.done,
    push?.loop.done,
    cleanup?.loop.done,
    reconcile?.loop.done,
    backup?.loop.done,
    attachments?.loop.done,
  ].filter((entry): entry is Promise<void> => entry !== undefined);
  return {
    done: Promise.all(loops).then(() => undefined),
    ...(merge === undefined ? {} : { merge: merge.executor }),
    ...(push === undefined ? {} : { push: push.executor }),
    ...(cleanup === undefined ? {} : { cleanup: cleanup.executor }),
    ...(reconcile === undefined ? {} : { reconcile: reconcile.executor }),
    ...(backup === undefined ? {} : { backup: backup.executor }),
    ...(attachments === undefined ? {} : { attachments: attachments.executor }),
    stop: async () => {
      // Cancel checks promptly; wait below before closing the shared Store.
      merge?.executor.stop();
      push?.executor.stop();
      // Dispatcher first (no new work), then the phases in a fixed order; each
      // stop waits for its current tick, so SIGTERM never cuts a merge or a
      // worktree removal in half.
      await loop.stop();
      await merge?.loop.stop();
      await push?.loop.stop();
      await cleanup?.loop.stop();
      await reconcile?.loop.stop();
      await backup?.loop.stop();
      // The blob sweep last: it only touches files no record references.
      await attachments?.loop.stop();
    },
  };
}
