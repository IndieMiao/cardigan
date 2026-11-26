import {
  DEFAULT_CHECK_RECOVERY_INSPECTION_MS,
  DEFAULT_FRAMEWORK_WAIT_REMINDER_MS,
  DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_MERGE_BLOCKED_REMINDER_MS,
  DEFAULT_PROVIDER_COOLDOWN_MS,
  DEFAULT_PROVIDER_FAILURES,
  DEFAULT_STORY_SUMMARY_HANDOFF_MS,
  MAX_RUNTIME_FAILURE_LIMIT,
  MIN_RUNTIME_FAILURE_LIMIT,
  parseRuntimeUnknownGraceMs,
} from "@cardigan/domain";
import { DEFAULT_CHECK_CLEANUP_GRACE_MS } from "@cardigan/git-service";
import { resolveAttachmentInlineBytes } from "@cardigan/mcp-server";
import {
  BUILD_RETRY_BASE_MS,
  BUILD_RETRY_MAX_MS,
} from "./build-cleanup-retry.js";
import {
  DEFAULT_CENTRAL_CRUFT_INTERVAL_MS,
  DEFAULT_CENTRAL_MAINTENANCE_INTERVAL_MS,
  DEFAULT_CENTRAL_MAINTENANCE_WINDOW,
  type MaintenanceWindow,
  parseMaintenanceWindow,
} from "./central-maintenance-loop.js";
import { DEFAULT_CENTRAL_REF_RETENTION_MS } from "./central-ref-retention.js";
import {
  type CheckHeadRetryOptions,
  DEFAULT_CHECK_HEAD_RETRY,
} from "./check-head-retry.js";
import { DEFAULT_MERGE_WATCHDOG_MS } from "./merge-watchdog.js";

export const DEFAULT_DATA_DIR = defaultDataDirectory();
/**
 * M1 only listens on this machine (§3, §9.1): LAN listening arrives with the
 * multi-machine phase and needs TLS or a private network on top.
 */
export const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"] as const;
export const DEFAULT_MCP_HOST = "127.0.0.1";
export const LOCAL_ONLY_HINT =
  "M1 只支持本机监听（127.0.0.1、::1、localhost）；监听局域网/所有网卡属于 Phase 2 的多机范围，需要配合 TLS 或私有网络";
export const DEFAULT_MCP_PORT = 3004;

export interface ServerConfig {
  readonly attachmentInlineBytes?: number;
  /** Host configuration only; defaults: 64 KiB/read, 1 MiB/Assignment/attempt. */
  readonly checkLogLimits?: {
    readonly per_read_bytes: number;
    readonly per_assignment_attempt_bytes: number;
  };
  /** C-632: request_check busy-lock retry; defaults when no variable is set. */
  readonly checkHeadRetry?: CheckHeadRetryOptions;
  readonly execution?: ExecutionConfig;
  readonly dataDir: string;
  /** Loopback by default; the MCP endpoint is never exposed publicly (§14). */
  readonly host: string;
  /** `0` asks the OS for a free port (tests). */
  readonly port: number;
  /** EADDRINUSE retry cadence and shared startup wait budget, in milliseconds. */
  readonly launchReloadIntervalMs?: number;
  readonly listenRetryIntervalMs?: number;
  readonly listenRetryTimeoutMs?: number;
  /** M4.4 phase loops; every value has a default and is overridable. */
  readonly mergeWatchdogMs?: number;
  readonly mergeIntervalMs?: number;
  readonly frameworkWaitReminderMs?: number;
  /** C-762: external Office summary wait before PM Ops drafts it. */
  readonly storySummaryHandoffMs?: number;
  readonly mergeBlockedReminderMs?: number;
  readonly cleanupIntervalMs?: number;
  /** C-791: first wait and cap of a failed build removal's backoff. */
  readonly buildRetryBaseMs?: number;
  readonly buildRetryMaxMs?: number;
  readonly reconcileIntervalMs?: number;
  readonly checkCleanupGraceMs?: number;
  /** Q-618: five minutes by default, configurable in trusted host environment. */
  readonly recoveryInspectionIntervalMs?: number;
  readonly backupIntervalMs?: number;
  /** C-637: off-peak central repository maintenance (host local time); undefined is off. */
  readonly centralMaintenanceWindow?: MaintenanceWindow;
  readonly centralMaintenanceIntervalMs?: number;
  readonly centralCruftIntervalMs?: number;
  /** Q-1233: 14 days after the owning card ended. */
  readonly centralRefRetentionMs?: number;
  /** Orphaned attachment blobs (§9.3); 6 hours by default. */
  readonly attachmentIntervalMs?: number;
  readonly providerFailureThreshold?: number;
  readonly providerCooldownMs?: number;
  readonly dispatchTimeoutMs?: number;
  readonly workerInspectionIntervalMs?: number;
  readonly hostOpsPatrolIntervalMs?: number;
  readonly contextUsageCacheDir?: string;
  readonly contextUsageStaleAfterMs?: number;
  /** C-741: CARDIGAN_CONTEXT_RESTART_RETRY_DELAYS_MS, comma-separated; default 2, 5, 10 minutes. */
  readonly contextRestartRetryDelaysMs?: readonly number[];
  readonly dispatchIntervalMs?: number;
  readonly runtimeFailureLimit?: number;
  /** C-228 / Q-387: CARDIGAN_RUNTIME_UNKNOWN_GRACE_SECONDS, default 60 s. */
  readonly runtimeUnknownGraceMs?: number;
  /**
   * After SIGTERM, how long in-flight Workbench requests may run before their
   * connections are cut; SSE streams end at once. 10 seconds by default.
   */
  readonly shutdownGraceMs?: number;
  /**
   * C-600: refuse tool calls from a new session whose harness never listed
   * the Card tools and rebuild it once. On unless CARDIGAN_MCP_SESSION_CHECK=0.
   */
  readonly mcpSessionCheck?: boolean;
  /** C-600: CARDIGAN_MCP_HANDSHAKE_TIMEOUT_MS; 180 s by default. */
  readonly mcpHandshakeTimeoutMs?: number;
}

export interface ServerEnv extends ExecutionEnv {
  readonly CARDIGAN_ARTIFACT_PUBLICATION?: string | undefined;
  readonly CARDIGAN_MOBILE_SIGNING?: string | undefined;
  readonly CARDIGAN_ATTACHMENT_INLINE_BYTES?: string | undefined;
  /** hc session the runtime uses; registered for the CLI (C-152). */
  readonly CARDIGAN_HC_SESSION?: string | undefined;
  readonly CARDIGAN_CONFIG_DIR?: string | undefined;
  readonly CARDIGAN_DATA_DIR?: string | undefined;
  /** C-216: `1` turns on the periodic-loop profiler; default off. */
  readonly CARDIGAN_TICK_PROFILE?: string | undefined;
  readonly CARDIGAN_CHECK_LOG_READ_BYTES?: string | undefined;
  readonly CARDIGAN_CHECK_LOG_ATTEMPT_BYTES?: string | undefined;
  readonly CARDIGAN_MCP_HOST?: string | undefined;
  readonly CARDIGAN_MCP_PORT?: string | undefined;
  readonly CARDIGAN_LAUNCH_RELOAD_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_LISTEN_RETRY_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_LISTEN_RETRY_TIMEOUT_MS?: string | undefined;
  /**
   * Workbench settings. The listen address is never configurable
   * (`resolveWebConfig` refuses anything but loopback), so listing it here
   * keeps the whole server configuration in one interface.
   */
  readonly CARDIGAN_WEB_PORT?: string | undefined;
  readonly CARDIGAN_WEB_PUBLIC_ORIGINS?: string | undefined;
  readonly CARDIGAN_MERGE_WATCHDOG_MS?: string | undefined;
  readonly CARDIGAN_MERGE_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_FRAMEWORK_WAIT_REMINDER_MS?: string | undefined;
  readonly CARDIGAN_STORY_SUMMARY_HANDOFF_MS?: string | undefined;
  readonly CARDIGAN_MERGE_BLOCKED_REMINDER_MS?: string | undefined;
  readonly CARDIGAN_CLEANUP_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_BUILD_RETRY_BASE_MS?: string | undefined;
  readonly CARDIGAN_BUILD_RETRY_MAX_MS?: string | undefined;
  readonly CARDIGAN_RECONCILE_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_CHECK_CLEANUP_GRACE_MS?: string | undefined;
  readonly CARDIGAN_CHECK_RECOVERY_INSPECTION_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_BACKUP_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_CENTRAL_MAINTENANCE_WINDOW?: string | undefined;
  readonly CARDIGAN_CENTRAL_MAINTENANCE_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_CENTRAL_CRUFT_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_CENTRAL_REF_RETENTION_DAYS?: string | undefined;
  readonly CARDIGAN_ATTACHMENT_GC_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_PROVIDER_FAILURE_THRESHOLD?: string | undefined;
  readonly CARDIGAN_PROVIDER_COOLDOWN_MS?: string | undefined;
  readonly CARDIGAN_DISPATCH_TIMEOUT_MS?: string | undefined;
  readonly CARDIGAN_WORKER_INSPECTION_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_HOST_OPS_PATROL_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_CONTEXT_USAGE_CACHE_DIR?: string | undefined;
  readonly CARDIGAN_CONTEXT_USAGE_STALE_AFTER_MS?: string | undefined;
  readonly CARDIGAN_CONTEXT_RESTART_RETRY_DELAYS_MS?: string | undefined;
  readonly CARDIGAN_DISPATCH_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_RUNTIME_FAILURE_LIMIT?: string | undefined;
  readonly CARDIGAN_RUNTIME_UNKNOWN_GRACE_SECONDS?: string | undefined;
  readonly CARDIGAN_SHUTDOWN_GRACE_MS?: string | undefined;
  readonly CARDIGAN_MCP_SESSION_CHECK?: string | undefined;
  readonly CARDIGAN_MCP_HANDSHAKE_TIMEOUT_MS?: string | undefined;
  readonly CARDIGAN_CHECK_HEAD_RETRY_ATTEMPTS?: string | undefined;
  readonly CARDIGAN_CHECK_HEAD_RETRY_TOTAL_MS?: string | undefined;
  readonly CARDIGAN_CHECK_HEAD_RETRY_BACKOFF_MS?: string | undefined;
}

export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
export const DEFAULT_LISTEN_RETRY_INTERVAL_MS = 1_000;
export const DEFAULT_LISTEN_RETRY_TIMEOUT_MS = 30_000;

/** Default cadence of the M4.4 phase loops (plan §3.6, §3.7). */
export const DEFAULT_INTERVALS = {
  merge: 5_000,
  cleanup: 60_000,
  reconcile: 600_000,
  backup: 600_000,
  attachment: 21_600_000,
} as const;

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim().length === 0 ? undefined : value.trim();

/** Read the server configuration from the environment (§3, §13.1). */
export function resolveServerConfig(env: ServerEnv): ServerConfig {
  const inlineText = nonEmpty(env.CARDIGAN_ATTACHMENT_INLINE_BYTES);
  const attachmentInlineBytes =
    inlineText === undefined
      ? undefined
      : resolveAttachmentInlineBytes(Number(inlineText));
  const logRead = nonEmpty(env.CARDIGAN_CHECK_LOG_READ_BYTES);
  const logAttempt = nonEmpty(env.CARDIGAN_CHECK_LOG_ATTEMPT_BYTES);
  const positiveInteger = (
    text: string | undefined,
    fallback: number,
    name: string,
  ) => {
    if (text === undefined) return fallback;
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`${name} must be a positive safe integer`);
    return value;
  };
  const checkLogLimits =
    logRead === undefined && logAttempt === undefined
      ? undefined
      : {
          per_read_bytes: positiveInteger(
            logRead,
            64 * 1024,
            "CARDIGAN_CHECK_LOG_READ_BYTES",
          ),
          per_assignment_attempt_bytes: positiveInteger(
            logAttempt,
            1024 * 1024,
            "CARDIGAN_CHECK_LOG_ATTEMPT_BYTES",
          ),
        };
  const failureLimitText = nonEmpty(env.CARDIGAN_RUNTIME_FAILURE_LIMIT);
  const runtimeFailureLimit =
    failureLimitText === undefined ? undefined : Number(failureLimitText);
  if (
    runtimeFailureLimit !== undefined &&
    (!Number.isSafeInteger(runtimeFailureLimit) ||
      runtimeFailureLimit < MIN_RUNTIME_FAILURE_LIMIT ||
      runtimeFailureLimit > MAX_RUNTIME_FAILURE_LIMIT)
  )
    throw new Error(
      `CARDIGAN_RUNTIME_FAILURE_LIMIT must be an integer from ${MIN_RUNTIME_FAILURE_LIMIT} to ${MAX_RUNTIME_FAILURE_LIMIT} (Q-387)`,
    );
  const runtimeUnknownGraceMs = parseRuntimeUnknownGraceMs(
    env.CARDIGAN_RUNTIME_UNKNOWN_GRACE_SECONDS,
  );
  const centralMaintenanceWindow = parseMaintenanceWindow(
    nonEmpty(env.CARDIGAN_CENTRAL_MAINTENANCE_WINDOW) ??
      DEFAULT_CENTRAL_MAINTENANCE_WINDOW,
  );
  const portText = nonEmpty(env.CARDIGAN_MCP_PORT);
  const port = portText === undefined ? DEFAULT_MCP_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `CARDIGAN_MCP_PORT must be an integer between 0 and 65535, got ${JSON.stringify(portText)}`,
    );
  }
  const dataDir = resolveDataDirectory(env);
  const sessionCheck = nonEmpty(env.CARDIGAN_MCP_SESSION_CHECK);
  if (sessionCheck !== undefined && !["0", "1"].includes(sessionCheck))
    throw new Error("CARDIGAN_MCP_SESSION_CHECK must be 0 or 1");
  const checkHeadRetry = resolveCheckHeadRetry(env);
  return {
    mcpSessionCheck: sessionCheck !== "0",
    ...(checkHeadRetry ? { checkHeadRetry } : {}),
    ...(checkLogLimits ? { checkLogLimits } : {}),
    ...(attachmentInlineBytes === undefined ? {} : { attachmentInlineBytes }),
    dataDir,
    execution: resolveExecutionConfig({ ...env, CARDIGAN_DATA_DIR: dataDir }),
    host: resolveHost(env.CARDIGAN_MCP_HOST),
    port,
    launchReloadIntervalMs: interval(
      env.CARDIGAN_LAUNCH_RELOAD_INTERVAL_MS,
      "CARDIGAN_LAUNCH_RELOAD_INTERVAL_MS",
      1000,
    ),
    listenRetryIntervalMs: interval(
      env.CARDIGAN_LISTEN_RETRY_INTERVAL_MS,
      "CARDIGAN_LISTEN_RETRY_INTERVAL_MS",
      DEFAULT_LISTEN_RETRY_INTERVAL_MS,
    ),
    listenRetryTimeoutMs: interval(
      env.CARDIGAN_LISTEN_RETRY_TIMEOUT_MS,
      "CARDIGAN_LISTEN_RETRY_TIMEOUT_MS",
      DEFAULT_LISTEN_RETRY_TIMEOUT_MS,
    ),
    ...(nonEmpty(env.CARDIGAN_CONTEXT_USAGE_CACHE_DIR)
      ? {
          contextUsageCacheDir: nonEmpty(
            env.CARDIGAN_CONTEXT_USAGE_CACHE_DIR,
          ) as string,
        }
      : {}),
    contextUsageStaleAfterMs: interval(
      env.CARDIGAN_CONTEXT_USAGE_STALE_AFTER_MS,
      "CARDIGAN_CONTEXT_USAGE_STALE_AFTER_MS",
      600_000,
    ),
    ...(nonEmpty(env.CARDIGAN_CONTEXT_RESTART_RETRY_DELAYS_MS) === undefined
      ? {}
      : {
          contextRestartRetryDelaysMs: retryDelays(
            env.CARDIGAN_CONTEXT_RESTART_RETRY_DELAYS_MS as string,
            "CARDIGAN_CONTEXT_RESTART_RETRY_DELAYS_MS",
          ),
        }),
    ...(env.CARDIGAN_WORKER_INSPECTION_INTERVAL_MS
      ? {
          workerInspectionIntervalMs: positiveInteger(
            env.CARDIGAN_WORKER_INSPECTION_INTERVAL_MS,
            10000,
            "CARDIGAN_WORKER_INSPECTION_INTERVAL_MS",
          ),
        }
      : {}),
    hostOpsPatrolIntervalMs: interval(
      env.CARDIGAN_HOST_OPS_PATROL_INTERVAL_MS,
      "CARDIGAN_HOST_OPS_PATROL_INTERVAL_MS",
      1_800_000,
    ),
    ...(nonEmpty(env.CARDIGAN_DISPATCH_INTERVAL_MS) === undefined
      ? {}
      : {
          dispatchIntervalMs: interval(
            env.CARDIGAN_DISPATCH_INTERVAL_MS,
            "CARDIGAN_DISPATCH_INTERVAL_MS",
            1000,
          ),
        }),
    providerFailureThreshold: interval(
      env.CARDIGAN_PROVIDER_FAILURE_THRESHOLD,
      "CARDIGAN_PROVIDER_FAILURE_THRESHOLD",
      DEFAULT_PROVIDER_FAILURES,
    ),
    providerCooldownMs: interval(
      env.CARDIGAN_PROVIDER_COOLDOWN_MS,
      "CARDIGAN_PROVIDER_COOLDOWN_MS",
      DEFAULT_PROVIDER_COOLDOWN_MS,
    ),
    dispatchTimeoutMs: interval(
      env.CARDIGAN_DISPATCH_TIMEOUT_MS,
      "CARDIGAN_DISPATCH_TIMEOUT_MS",
      600_000,
    ),
    ...(nonEmpty(env.CARDIGAN_MCP_HANDSHAKE_TIMEOUT_MS) === undefined
      ? {}
      : {
          mcpHandshakeTimeoutMs: interval(
            env.CARDIGAN_MCP_HANDSHAKE_TIMEOUT_MS,
            "CARDIGAN_MCP_HANDSHAKE_TIMEOUT_MS",
            DEFAULT_MCP_HANDSHAKE_TIMEOUT_MS,
          ),
        }),
    ...(runtimeFailureLimit === undefined ? {} : { runtimeFailureLimit }),
    runtimeUnknownGraceMs,
    ...(nonEmpty(env.CARDIGAN_FRAMEWORK_WAIT_REMINDER_MS) === undefined
      ? {}
      : {
          frameworkWaitReminderMs: interval(
            env.CARDIGAN_FRAMEWORK_WAIT_REMINDER_MS,
            "CARDIGAN_FRAMEWORK_WAIT_REMINDER_MS",
            DEFAULT_FRAMEWORK_WAIT_REMINDER_MS,
          ),
        }),
    ...(nonEmpty(env.CARDIGAN_STORY_SUMMARY_HANDOFF_MS) === undefined
      ? {}
      : {
          storySummaryHandoffMs: interval(
            env.CARDIGAN_STORY_SUMMARY_HANDOFF_MS,
            "CARDIGAN_STORY_SUMMARY_HANDOFF_MS",
            DEFAULT_STORY_SUMMARY_HANDOFF_MS,
          ),
        }),
    ...(nonEmpty(env.CARDIGAN_MERGE_BLOCKED_REMINDER_MS) === undefined
      ? {}
      : {
          mergeBlockedReminderMs: interval(
            env.CARDIGAN_MERGE_BLOCKED_REMINDER_MS,
            "CARDIGAN_MERGE_BLOCKED_REMINDER_MS",
            DEFAULT_MERGE_BLOCKED_REMINDER_MS,
          ),
        }),
    mergeWatchdogMs: interval(
      env.CARDIGAN_MERGE_WATCHDOG_MS,
      "CARDIGAN_MERGE_WATCHDOG_MS",
      DEFAULT_MERGE_WATCHDOG_MS,
    ),
    mergeIntervalMs: interval(
      env.CARDIGAN_MERGE_INTERVAL_MS,
      "CARDIGAN_MERGE_INTERVAL_MS",
      DEFAULT_INTERVALS.merge,
    ),
    recoveryInspectionIntervalMs: interval(
      env.CARDIGAN_CHECK_RECOVERY_INSPECTION_INTERVAL_MS,
      "CARDIGAN_CHECK_RECOVERY_INSPECTION_INTERVAL_MS",
      DEFAULT_CHECK_RECOVERY_INSPECTION_MS,
    ),
    cleanupIntervalMs: interval(
      env.CARDIGAN_CLEANUP_INTERVAL_MS,
      "CARDIGAN_CLEANUP_INTERVAL_MS",
      DEFAULT_INTERVALS.cleanup,
    ),
    buildRetryBaseMs: interval(
      env.CARDIGAN_BUILD_RETRY_BASE_MS,
      "CARDIGAN_BUILD_RETRY_BASE_MS",
      BUILD_RETRY_BASE_MS,
    ),
    buildRetryMaxMs: interval(
      env.CARDIGAN_BUILD_RETRY_MAX_MS,
      "CARDIGAN_BUILD_RETRY_MAX_MS",
      BUILD_RETRY_MAX_MS,
    ),
    reconcileIntervalMs: interval(
      env.CARDIGAN_RECONCILE_INTERVAL_MS,
      "CARDIGAN_RECONCILE_INTERVAL_MS",
      DEFAULT_INTERVALS.reconcile,
    ),
    backupIntervalMs: interval(
      env.CARDIGAN_BACKUP_INTERVAL_MS,
      "CARDIGAN_BACKUP_INTERVAL_MS",
      DEFAULT_INTERVALS.backup,
    ),
    ...(centralMaintenanceWindow === undefined
      ? {}
      : { centralMaintenanceWindow }),
    centralMaintenanceIntervalMs: interval(
      env.CARDIGAN_CENTRAL_MAINTENANCE_INTERVAL_MS,
      "CARDIGAN_CENTRAL_MAINTENANCE_INTERVAL_MS",
      DEFAULT_CENTRAL_MAINTENANCE_INTERVAL_MS,
    ),
    centralCruftIntervalMs: interval(
      env.CARDIGAN_CENTRAL_CRUFT_INTERVAL_MS,
      "CARDIGAN_CENTRAL_CRUFT_INTERVAL_MS",
      DEFAULT_CENTRAL_CRUFT_INTERVAL_MS,
    ),
    centralRefRetentionMs:
      positiveInteger(
        nonEmpty(env.CARDIGAN_CENTRAL_REF_RETENTION_DAYS),
        DEFAULT_CENTRAL_REF_RETENTION_MS / 86_400_000,
        "CARDIGAN_CENTRAL_REF_RETENTION_DAYS",
      ) * 86_400_000,
    checkCleanupGraceMs: interval(
      env.CARDIGAN_CHECK_CLEANUP_GRACE_MS,
      "CARDIGAN_CHECK_CLEANUP_GRACE_MS",
      DEFAULT_CHECK_CLEANUP_GRACE_MS,
    ),
    attachmentIntervalMs: interval(
      env.CARDIGAN_ATTACHMENT_GC_INTERVAL_MS,
      "CARDIGAN_ATTACHMENT_GC_INTERVAL_MS",
      DEFAULT_INTERVALS.attachment,
    ),
    shutdownGraceMs: interval(
      env.CARDIGAN_SHUTDOWN_GRACE_MS,
      "CARDIGAN_SHUTDOWN_GRACE_MS",
      DEFAULT_SHUTDOWN_GRACE_MS,
    ),
  };
}

function resolveCheckHeadRetry(
  env: ServerEnv,
): CheckHeadRetryOptions | undefined {
  const attemptsText = nonEmpty(env.CARDIGAN_CHECK_HEAD_RETRY_ATTEMPTS);
  if (
    attemptsText === undefined &&
    nonEmpty(env.CARDIGAN_CHECK_HEAD_RETRY_TOTAL_MS) === undefined &&
    nonEmpty(env.CARDIGAN_CHECK_HEAD_RETRY_BACKOFF_MS) === undefined
  )
    return undefined;
  const attempts =
    attemptsText === undefined
      ? DEFAULT_CHECK_HEAD_RETRY.attempts
      : Number(attemptsText);
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10)
    throw new Error(
      "CARDIGAN_CHECK_HEAD_RETRY_ATTEMPTS must be an integer from 1 to 10",
    );
  return {
    attempts,
    totalMs: interval(
      env.CARDIGAN_CHECK_HEAD_RETRY_TOTAL_MS,
      "CARDIGAN_CHECK_HEAD_RETRY_TOTAL_MS",
      DEFAULT_CHECK_HEAD_RETRY.totalMs,
    ),
    backoffMs: interval(
      env.CARDIGAN_CHECK_HEAD_RETRY_BACKOFF_MS,
      "CARDIGAN_CHECK_HEAD_RETRY_BACKOFF_MS",
      DEFAULT_CHECK_HEAD_RETRY.backoffMs,
    ),
  };
}

/** 1-10 comma-separated positive millisecond delays. */
function retryDelays(value: string, name: string): readonly number[] {
  const parts = value.split(",").map((part) => part.trim());
  if (parts.length > 10 || parts.some((part) => part === ""))
    throw new Error(`${name} must list 1-10 comma-separated milliseconds`);
  return parts.map((part) => interval(part, name, 0));
}

function interval(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  const text = nonEmpty(value);
  if (text === undefined) return fallback;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647)
    throw new Error(`${name} must be a positive integer of milliseconds`);
  return parsed;
}

/**
 * Accept only loopback addresses. `0.0.0.0`, `::` and LAN addresses would put
 * the MCP endpoint on the network, which M1 must not do.
 */
function resolveHost(value: string | undefined): string {
  const requested = nonEmpty(value);
  if (requested === undefined) {
    return DEFAULT_MCP_HOST;
  }
  const normalized = requested.toLowerCase();
  if ((LOOPBACK_HOSTS as readonly string[]).includes(normalized)) {
    return normalized;
  }
  throw new Error(
    `CARDIGAN_MCP_HOST=${JSON.stringify(requested)} 不受支持。${LOCAL_ONLY_HINT}`,
  );
}

import {
  defaultDataDirectory,
  type ExecutionConfig,
  type ExecutionEnv,
  resolveDataDirectory,
  resolveExecutionConfig,
} from "@cardigan/runtime-herdr";
