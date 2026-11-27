import type { Clock, ProjectId } from "@cardigan/domain";
import { RuntimeTargets } from "@cardigan/host";
import type { LaunchConfig } from "@cardigan/roles";
import { type Store, standingResolver } from "@cardigan/store";
import { type AttachmentGc, startAttachmentLoop } from "./attachment-loop.js";
import type { BuildRetryPolicy } from "./build-cleanup-retry.js";
import {
  type MaintenanceWindow,
  startCentralMaintenanceLoop,
} from "./central-maintenance-loop.js";
import { storeRefOwners } from "./central-ref-retention.js";
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
import { EarlyConflictObserver } from "./early-conflicts.js";
import type { GitPhases } from "./git.js";
import type { LoopStartup } from "./loop.js";
import { startMachineCapabilityLoop } from "./machine-capability-loop.js";
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
import { startRunDirLoop } from "./run-dir-cleanup.js";
import { startRunResourceLoop } from "./run-resource-cleanup.js";
import type { MachineHost } from "./web/machine-host.js";
import { WorkerUsageMonitor, workerLowFreeBytes } from "./worker-usage.js";

/**
 * M3.5: the control plane the server runs beside the MCP endpoint.
 *
 * The Store, Runtime and MCP endpoint are owned by the caller; this module only
 * owns the loops, so shutdown order stays explicit:
 * `stop()` (loop + monitor drain) → close the MCP endpoint → close the Store.
 */
export interface ControlPlaneOptions {
  readonly startup?: LoopStartup;
  readonly machineHost?: MachineHost;
  readonly upstream?: LaunchConfig;
  readonly hostOpsTick?: () => Promise<void>;
  readonly harnessActivity?: DispatcherOptions["harnessActivity"];
  readonly harnessFileActivity?: DispatcherOptions["harnessFileActivity"];
  readonly inspectHarnessActivity?: DispatcherOptions["inspectHarnessActivity"];
  readonly recordLaunchEvidence?: DispatcherOptions["recordLaunchEvidence"];
  readonly inactivityInspectionTimeoutMs?: number;
  readonly hostOpsPatrolIntervalMs?: number;
  readonly store: Store;
  readonly runtime: DispatcherOptions["runtime"] &
    RuntimeMonitorOptions["runtime"];
  readonly snapshot: DispatcherOptions["snapshot"];
  readonly toolCatalog?: DispatcherOptions["toolCatalog"];
  readonly toolCatalogCompatible?: DispatcherOptions["toolCatalogCompatible"];
  readonly runLimit?: DispatcherOptions["runLimit"];
  readonly leases?: DispatcherOptions["leases"];
  readonly projectQuota?: DispatcherOptions["projectQuota"];
  readonly resourceLimits?: DispatcherOptions["resourceLimits"];
  readonly runLimitMaximum?: DispatcherOptions["runLimitMaximum"];
  readonly startRun: DispatcherOptions["startRun"];
  readonly recoverLaunches?: DispatcherOptions["recoverLaunches"];
  readonly beforeWake?: DispatcherOptions["beforeWake"];
  readonly frameworkWaitReminderMs?: number;
  readonly storySummaryHandoffMs?: number;
  readonly baselineConflictMaxResumes?: number;
  readonly authorPrecheckFailureLimit?: number;
  readonly standing?: StandingResolver;
  readonly clock?: Clock;
  readonly intervalMs?: number;
  readonly deliveryLeaseMs?: number;
  readonly retryBaseMs?: number;
  readonly maxRetries?: number;
  readonly inactivityGraceMs?: number;
  readonly providerFailureThreshold?: number;
  readonly providerCooldownMs?: number;
  readonly dispatchTimeoutMs?: number;
  readonly deliveryRetryBaseMs?: number;
  readonly queuedRecheckAfterMs?: number;
  readonly inboxStallAfterMs?: number;
  readonly inactiveCancelAfterMs?: number | null;
  readonly scarceInactiveCancel?: DispatcherOptions["scarceInactiveCancel"];
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
  readonly mergeWatchdogMs?: number;
  readonly mergeIntervalMs?: number;
  readonly mergeBlockedReminderMs?: number;
  readonly cleanupIntervalMs?: number;
  /** C-791: backoff of failed build removals. */
  readonly buildRetry?: Partial<BuildRetryPolicy>;
  readonly reconcileIntervalMs?: number;
  readonly backupIntervalMs?: number;
  /** C-637: off-peak central repository maintenance; off without a window. */
  readonly centralMaintenanceWindow?: MaintenanceWindow;
  readonly centralMaintenanceIntervalMs?: number;
  readonly centralCruftIntervalMs?: number;
  /** Q-1233: candidate and precheck refs outlive their ended card by this long. */
  readonly centralRefRetentionMs?: number;
  readonly centralMaintenanceLog?: (line: Record<string, unknown>) => void;
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

export { standingResolver };

export function startControlPlane(options: ControlPlaneOptions): ControlPlane {
  const clock = options.clock ?? dispatcherClock;
  const standing = options.standing ?? standingResolver(options.store);
  const shadow = new MergeShadowObserver(options.store, options.git, clock);
  const early = new EarlyConflictObserver(options.store, options.git, clock);
  const dispatcher = new Dispatcher({
    roleUpgradePass: "beside",
    ...(options.git?.proveReviewLimit
      ? { proveReviewLimit: options.git.proveReviewLimit.bind(options.git) }
      : {}),
    mergeGateEnabled: (project) =>
      (options.mergeGate?.configuration.forProject(project).status ??
        "disabled") !== "disabled",
    mergeShadowTick: (project) => shadow.tick(project),
    earlyConflictTick: (project) => early.tick(project),
    ...(options.frameworkWaitReminderMs !== undefined
      ? { frameworkWaitReminderMs: options.frameworkWaitReminderMs }
      : {}),
    ...(options.storySummaryHandoffMs !== undefined
      ? { storySummaryHandoffMs: options.storySummaryHandoffMs }
      : {}),
    ...(options.authorPrecheckFailureLimit !== undefined
      ? { authorPrecheckFailureLimit: options.authorPrecheckFailureLimit }
      : {}),
    ...(options.baselineConflictMaxResumes !== undefined
      ? { baselineConflictMaxResumes: options.baselineConflictMaxResumes }
      : {}),
    baselineForWait: async (project) => {
      const binding = options.git?.projectOf(project);
      if (!binding || !options.git?.baseline) return undefined;
      return {
        branch: binding.base_branch,
        sha: await options.git.baseline(binding),
      };
    },
    ...(options.hostOpsTick ? { hostOpsTick: options.hostOpsTick } : {}),
    ...(options.harnessActivity
      ? { harnessActivity: options.harnessActivity }
      : {}),
    ...(options.harnessFileActivity
      ? { harnessFileActivity: options.harnessFileActivity }
      : {}),
    ...(options.inspectHarnessActivity
      ? { inspectHarnessActivity: options.inspectHarnessActivity }
      : {}),
    ...(options.recordLaunchEvidence
      ? { recordLaunchEvidence: options.recordLaunchEvidence }
      : {}),
    ...(options.inactivityInspectionTimeoutMs === undefined
      ? {}
      : {
          inactivityInspectionTimeoutMs: options.inactivityInspectionTimeoutMs,
        }),
    ...(options.hostOpsPatrolIntervalMs === undefined
      ? {}
      : { hostOpsPatrolIntervalMs: options.hostOpsPatrolIntervalMs }),
    store: options.store,
    runtime: options.runtime,
    clock,
    standing,
    snapshot: options.snapshot,
    ...(options.toolCatalog ? { toolCatalog: options.toolCatalog } : {}),
    ...(options.toolCatalogCompatible
      ? { toolCatalogCompatible: options.toolCatalogCompatible }
      : {}),
    ...(options.queuedRecheckAfterMs !== undefined
      ? { queuedRecheckAfterMs: options.queuedRecheckAfterMs }
      : {}),
    ...(options.inboxStallAfterMs !== undefined
      ? { inboxStallAfterMs: options.inboxStallAfterMs }
      : {}),
    ...(options.inactiveCancelAfterMs === undefined
      ? {}
      : { inactiveCancelAfterMs: options.inactiveCancelAfterMs }),
    ...(options.scarceInactiveCancel
      ? { scarceInactiveCancel: options.scarceInactiveCancel }
      : {}),
    ...(options.runLimit ? { runLimit: options.runLimit } : {}),
    ...(options.leases ? { leases: options.leases } : {}),
    ...(options.projectQuota ? { projectQuota: options.projectQuota } : {}),
    ...(options.resourceLimits
      ? { resourceLimits: options.resourceLimits }
      : {}),
    ...(options.runLimitMaximum
      ? { runLimitMaximum: options.runLimitMaximum }
      : {}),
    startRun: options.startRun,
    ...(options.recoverLaunches
      ? { recoverLaunches: options.recoverLaunches }
      : {}),
    ...(options.providerFailureThreshold !== undefined
      ? { providerFailureThreshold: options.providerFailureThreshold }
      : {}),
    ...(options.providerCooldownMs !== undefined
      ? { providerCooldownMs: options.providerCooldownMs }
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
    ...(options.git?.snapshotOrphan
      ? { snapshotOrphan: options.git.snapshotOrphan.bind(options.git) }
      : {}),
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
    startup: options.startup,
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
          startup: options.startup,
          store: options.store,
          git: options.git,
          clock,
          ...(options.mergeGate ? { gate: options.mergeGate } : {}),
          ...(options.mergeWatchdogMs === undefined
            ? {}
            : { watchdogMs: options.mergeWatchdogMs }),
          ...(options.mergeBlockedReminderMs === undefined
            ? {}
            : { mergeBlockedReminderMs: options.mergeBlockedReminderMs }),
          ...(options.mergeIntervalMs === undefined
            ? {}
            : { intervalMs: options.mergeIntervalMs }),
          onError: report,
          report: (message) => options.onError?.(new Error(message)),
        });
  const push =
    options.git && options.mergeGate
      ? startMergePushLoop({
          startup: options.startup,
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
          startup: options.startup,
          store: options.store,
          git: options.git,
          runtime: options.runtime,
          clock,
          ...(options.cleanupIntervalMs === undefined
            ? {}
            : { intervalMs: options.cleanupIntervalMs }),
          ...(options.buildRetry === undefined
            ? {}
            : { buildRetry: options.buildRetry }),
          onError: report,
          report: (message) => options.onError?.(new Error(message)),
        });
  // C-666: worker usage after each machine check; low space starts a reclaim.
  const usage =
    options.git?.machineUsage === undefined
      ? undefined
      : new WorkerUsageMonitor({
          store: options.store,
          git: options.git,
          clock,
          lowFreeBytes: workerLowFreeBytes(),
          ...(cleanup
            ? {
                // Never hold the machine patrol on a reclaim pass.
                reclaim: (project: ProjectId) => {
                  void cleanup.executor.reclaim(project).catch(report);
                },
              }
            : {}),
          report: (message) => options.onError?.(new Error(message)),
        });
  const machineCapabilities =
    options.runtime instanceof RuntimeTargets
      ? startMachineCapabilityLoop({
          startup: options.startup,
          store: options.store,
          runtime: options.runtime,
          ...(options.machineHost
            ? { verification: { host: options.machineHost, clock } }
            : {}),
          ...(usage
            ? { usage: (project, machine) => usage.observe(project, machine) }
            : {}),
          onError: report,
        })
      : undefined;
  const resources =
    options.git && options.runtime instanceof RuntimeTargets
      ? startRunResourceLoop(
          options.store,
          options.runtime,
          (line) => report(new Error(line)),
          options.startup,
          options.cleanupIntervalMs,
        )
      : undefined;
  // C-743: released Assignments' run directories, on every machine.
  const runDirs =
    options.git && options.runtime instanceof RuntimeTargets
      ? startRunDirLoop(
          options.store,
          options.runtime,
          (line) => report(new Error(line)),
          options.startup,
        )
      : undefined;
  const reconcile =
    options.git === undefined
      ? undefined
      : startReconcileLoop({
          startup: options.startup,
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
          startup: options.startup,
          store: options.store,
          git: options.git,
          clock,
          ...(options.backupIntervalMs === undefined
            ? {}
            : { intervalMs: options.backupIntervalMs }),
          onError: report,
          report: (message) => options.onError?.(new Error(message)),
        });
  const maintenance =
    options.git === undefined || options.centralMaintenanceWindow === undefined
      ? undefined
      : startCentralMaintenanceLoop({
          startup: options.startup,
          store: options.store,
          git: options.git,
          window: options.centralMaintenanceWindow,
          clock,
          ...(options.centralMaintenanceIntervalMs === undefined
            ? {}
            : { intervalMs: options.centralMaintenanceIntervalMs }),
          ...(options.centralCruftIntervalMs === undefined
            ? {}
            : { cruftIntervalMs: options.centralCruftIntervalMs }),
          refOwners: (project_id, cutoff) =>
            storeRefOwners(options.store, project_id, cutoff),
          ...(options.centralRefRetentionMs === undefined
            ? {}
            : { refRetentionMs: options.centralRefRetentionMs }),
          ...(options.centralMaintenanceLog === undefined
            ? {}
            : { log: options.centralMaintenanceLog }),
          onError: report,
          report: (message) => options.onError?.(new Error(message)),
        });
  // Orphaned content-addressed blobs (§9.3) are host housekeeping, not Git work:
  // the sweep runs even when the host wired no Git.
  const attachments =
    options.dataDir === undefined
      ? undefined
      : startAttachmentLoop({
          startup: options.startup,
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
    resources?.done,
    runDirs?.done,
    reconcile?.loop.done,
    backup?.loop.done,
    maintenance?.loop.done,
    attachments?.loop.done,
    machineCapabilities?.done,
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
      const stopResources = resources?.stop();
      const stopMachineCapabilities = machineCapabilities?.stop();
      // Dispatcher first (no new work), then the phases in a fixed order; each
      // stop waits for its current tick, so SIGTERM never cuts a merge or a
      // worktree removal in half.
      await loop.stop();
      await merge?.loop.stop();
      await push?.loop.stop();
      await cleanup?.loop.stop();
      // A removal round finishes its current directory before the Store closes.
      await runDirs?.stop();
      await reconcile?.loop.stop();
      await backup?.loop.stop();
      await maintenance?.loop.stop();
      // The blob sweep last: it only touches files no record references.
      await attachments?.loop.stop();
      await stopMachineCapabilities;
      await stopResources;
    },
  };
}
