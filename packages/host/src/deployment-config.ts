import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseDocument } from "yaml";

import {
  parseRetention,
  type RetentionPolicy,
} from "./deployment-retention-policy.js";

export interface DeploymentConfig {
  readonly enabled: boolean;
  readonly initial_release: string;
  readonly initial_sha: string;
  readonly ready_timeout_ms: number;
  readonly stop_timeout_ms: number;
  readonly poll_interval_ms: number;
  readonly build_timeout_ms: number;
  readonly evidence_wait_timeout_ms?: number;
  readonly capacity_wait_timeout_ms?: number;
  /** C-609: minimum gap between automatic restarts; 0 disables batching. */
  readonly batch_window_ms?: number;
  /** C-609: bounded wait for managed long operations; 0 disables it. */
  readonly operation_wait_timeout_ms?: number;
  readonly retention?: RetentionPolicy;
  readonly disk_low_percent?: number;
  readonly server_log_max_bytes?: number;
  /** C-638: with `server_log_max_bytes`, the directory's byte budget only. */
  readonly server_log_max_files?: number;
  /** C-638: server logs older than this are removed; default 48. */
  readonly server_log_retention_hours?: number;
}

export const DEFAULT_DISK_LOW_PERCENT = 15;
/** C-638: a year; retention is still bounded by the log byte budget. */
const MAX_SERVER_LOG_RETENTION_HOURS = 24 * 365;

/** Capacity waiting only raises attention; it never releases an unknown execution. */
export const DEFAULT_CAPACITY_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
/** Q-462: waiting for evidence only raises attention; it never authorizes deployment. */
export const DEFAULT_EVIDENCE_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
/** C-609: consecutive merges within five minutes of a restart deploy together. */
export const DEFAULT_BATCH_WINDOW_MS = 5 * 60 * 1000;
/** C-609: the wait for long operations ends in a deployment after 15 minutes. */
export const DEFAULT_OPERATION_WAIT_TIMEOUT_MS = 15 * 60 * 1000;
/** Optional keys where 0 turns the C-609 behavior off. */
const DISABLEABLE = ["batch_window_ms", "operation_wait_timeout_ms"];

/** Host policy only; no repository discovery or request-supplied deployment target. */
export async function loadDeploymentConfig(
  configDir: string,
): Promise<DeploymentConfig> {
  try {
    const file = resolve(configDir, "self-deploy.yaml");
    await requireHostDirectory(dirname(file));
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let source: string;
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        ![0, process.getuid?.()].includes(stat.uid) ||
        stat.mode & 0o077 ||
        stat.size > 65536
      )
        throw new Error();
      source = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    const doc = parseDocument(source, { uniqueKeys: true, strict: true });
    if (doc.errors.length || doc.warnings.length) throw new Error();
    return parseDeploymentConfig(doc.toJS({ maxAliasCount: 0 }));
  } catch {
    throw new Error("无法安全读取主机 self-deploy.yaml，自动部署未启动");
  }
}

export function parseDeploymentConfig(raw: unknown): DeploymentConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid deployment configuration");
  const value = raw as Record<string, unknown>;
  const keys = [
    "enabled",
    "initial_release",
    "initial_sha",
    "ready_timeout_ms",
    "stop_timeout_ms",
    "poll_interval_ms",
    "build_timeout_ms",
    "evidence_wait_timeout_ms",
    "capacity_wait_timeout_ms",
    "batch_window_ms",
    "operation_wait_timeout_ms",
    "retention",
    "disk_low_percent",
    "server_log_max_bytes",
    "server_log_max_files",
    "server_log_retention_hours",
  ];
  if (
    Object.keys(value).some((k) => !keys.includes(k)) ||
    (value.enabled !== undefined && typeof value.enabled !== "boolean") ||
    typeof value.initial_release !== "string" ||
    !isAbsolute(value.initial_release) ||
    value.initial_release === "/" ||
    value.initial_release !== resolve(value.initial_release) ||
    typeof value.initial_sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.initial_sha)
  )
    throw new Error("Invalid deployment configuration");
  for (const key of DISABLEABLE)
    if (
      value[key] !== undefined &&
      (!Number.isSafeInteger(value[key]) ||
        Number(value[key]) < 0 ||
        Number(value[key]) > 2147483647)
    )
      throw new Error("Invalid deployment timeout");
  for (const key of keys.filter(
    (k) => k.endsWith("_ms") && !DISABLEABLE.includes(k),
  ))
    if (
      !(
        ["evidence_wait_timeout_ms", "capacity_wait_timeout_ms"].includes(
          key,
        ) && value[key] === undefined
      ) &&
      (!Number.isSafeInteger(value[key]) ||
        Number(value[key]) < 1 ||
        Number(value[key]) > 2147483647)
    )
      throw new Error("Invalid deployment timeout");
  if (
    value.server_log_max_bytes !== undefined ||
    value.server_log_max_files !== undefined
  ) {
    for (const key of ["server_log_max_bytes", "server_log_max_files"])
      if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 1)
        throw new Error("Invalid server log limits");
    if (
      !Number.isSafeInteger(
        Number(value.server_log_max_bytes) * Number(value.server_log_max_files),
      )
    )
      throw new Error("Invalid server log capacity");
  }
  if (
    value.server_log_retention_hours !== undefined &&
    (value.server_log_max_bytes === undefined ||
      !Number.isSafeInteger(value.server_log_retention_hours) ||
      Number(value.server_log_retention_hours) < 1 ||
      Number(value.server_log_retention_hours) > MAX_SERVER_LOG_RETENTION_HOURS)
  )
    throw new Error("Invalid server log retention");
  if (
    value.disk_low_percent !== undefined &&
    (!Number.isInteger(value.disk_low_percent) ||
      Number(value.disk_low_percent) < 1 ||
      Number(value.disk_low_percent) > 100)
  )
    throw new Error("Invalid disk warning threshold");
  return {
    ...value,
    retention: parseRetention(
      value.retention === undefined ? {} : value.retention,
    ),
    disk_low_percent: value.disk_low_percent ?? DEFAULT_DISK_LOW_PERCENT,
    enabled: value.enabled ?? true,
    capacity_wait_timeout_ms:
      value.capacity_wait_timeout_ms ?? DEFAULT_CAPACITY_WAIT_TIMEOUT_MS,
    evidence_wait_timeout_ms:
      value.evidence_wait_timeout_ms ?? DEFAULT_EVIDENCE_WAIT_TIMEOUT_MS,
    batch_window_ms: value.batch_window_ms ?? DEFAULT_BATCH_WINDOW_MS,
    operation_wait_timeout_ms:
      value.operation_wait_timeout_ms ?? DEFAULT_OPERATION_WAIT_TIMEOUT_MS,
  } as unknown as DeploymentConfig;
}

export function deploymentDirectory(dataDir: string) {
  return join(dataDir, "self-deploy");
}

/** A writable ancestor would let an Agent substitute host state or executable code. */
export async function requireHostDirectory(directory: string): Promise<void> {
  for (let path = resolve(directory); ; path = dirname(path)) {
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      ![0, process.getuid?.()].includes(stat.uid) ||
      (stat.mode & 0o022 && !(stat.mode & 0o1000))
    )
      throw new Error("Unsafe host directory");
    if (path === dirname(path)) break;
  }
}
