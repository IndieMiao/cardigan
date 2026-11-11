import { DEFAULT_CHECK_CLEANUP_GRACE_MS } from "@cardigan/git-service";

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
  readonly execution?: ExecutionConfig;
  readonly dataDir: string;
  /** Loopback by default; the MCP endpoint is never exposed publicly (§14). */
  readonly host: string;
  /** `0` asks the OS for a free port (tests). */
  readonly port: number;
  /** M4.4 phase loops; every value has a default and is overridable. */
  readonly mergeIntervalMs?: number;
  readonly cleanupIntervalMs?: number;
  readonly reconcileIntervalMs?: number;
  readonly checkCleanupGraceMs?: number;
  readonly backupIntervalMs?: number;
  /** Orphaned attachment blobs (§9.3); 6 hours by default. */
  readonly attachmentIntervalMs?: number;
  readonly dispatchTimeoutMs?: number;
  readonly hostOpsPatrolIntervalMs?: number;
  readonly hostOpsContextThresholdPct?: number;
}

export interface ServerEnv extends ExecutionEnv {
  readonly CARDIGAN_CONFIG_DIR?: string | undefined;
  readonly CARDIGAN_DATA_DIR?: string | undefined;
  readonly CARDIGAN_MCP_HOST?: string | undefined;
  readonly CARDIGAN_MCP_PORT?: string | undefined;
  /**
   * Workbench settings. The listen address is never configurable
   * (`resolveWebConfig` refuses anything but loopback), so listing it here
   * keeps the whole server configuration in one interface.
   */
  readonly CARDIGAN_WEB_PORT?: string | undefined;
  readonly CARDIGAN_WEB_PUBLIC_ORIGINS?: string | undefined;
  readonly CARDIGAN_MERGE_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_CLEANUP_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_RECONCILE_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_CHECK_CLEANUP_GRACE_MS?: string | undefined;
  readonly CARDIGAN_BACKUP_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_ATTACHMENT_GC_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_DISPATCH_TIMEOUT_MS?: string | undefined;
  readonly CARDIGAN_HOST_OPS_PATROL_INTERVAL_MS?: string | undefined;
  readonly CARDIGAN_HOST_OPS_CONTEXT_THRESHOLD_PCT?: string | undefined;
}

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
  const portText = nonEmpty(env.CARDIGAN_MCP_PORT);
  const port = portText === undefined ? DEFAULT_MCP_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `CARDIGAN_MCP_PORT must be an integer between 0 and 65535, got ${JSON.stringify(portText)}`,
    );
  }
  const dataDir = resolveDataDirectory(env);
  return {
    dataDir,
    execution: resolveExecutionConfig({ ...env, CARDIGAN_DATA_DIR: dataDir }),
    host: resolveHost(env.CARDIGAN_MCP_HOST),
    port,
    hostOpsContextThresholdPct: percentage(
      env.CARDIGAN_HOST_OPS_CONTEXT_THRESHOLD_PCT,
    ),
    hostOpsPatrolIntervalMs: interval(
      env.CARDIGAN_HOST_OPS_PATROL_INTERVAL_MS,
      "CARDIGAN_HOST_OPS_PATROL_INTERVAL_MS",
      1_800_000,
    ),
    dispatchTimeoutMs: interval(
      env.CARDIGAN_DISPATCH_TIMEOUT_MS,
      "CARDIGAN_DISPATCH_TIMEOUT_MS",
      600_000,
    ),
    mergeIntervalMs: interval(
      env.CARDIGAN_MERGE_INTERVAL_MS,
      "CARDIGAN_MERGE_INTERVAL_MS",
      DEFAULT_INTERVALS.merge,
    ),
    cleanupIntervalMs: interval(
      env.CARDIGAN_CLEANUP_INTERVAL_MS,
      "CARDIGAN_CLEANUP_INTERVAL_MS",
      DEFAULT_INTERVALS.cleanup,
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
  };
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

function percentage(value?: string): number {
  const result = Number(nonEmpty(value) ?? "80");
  if (!Number.isFinite(result) || result < 1 || result > 100)
    throw new Error(
      "CARDIGAN_HOST_OPS_CONTEXT_THRESHOLD_PCT must be between 1 and 100",
    );
  return result;
}
