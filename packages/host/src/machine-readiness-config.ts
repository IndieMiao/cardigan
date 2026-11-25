import { lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { runtimeWorkersPath } from "./runtime-workers-config.js";
import { readOnboardingYaml } from "./worker-onboarding-config.js";

export interface ReadinessConfig {
  readonly disk_min_free_bytes: number;
  readonly min_throughput_bytes_per_s: number;
  readonly max_rtt_ms: number;
  readonly payload_bytes: number;
  readonly projects: Readonly<
    Record<
      string,
      {
        readonly android_avds: readonly string[];
        readonly ios_simulators: readonly string[];
      }
    >
  >;
}
const GIB = 1024 ** 3;
export const DEFAULT_READINESS_CONFIG: ReadinessConfig = Object.freeze({
  disk_min_free_bytes: 20 * GIB,
  min_throughput_bytes_per_s: 2_000_000,
  max_rtt_ms: 500,
  payload_bytes: 4 * 1024 * 1024,
  projects: Object.freeze({}),
});
const invalid = (): never => {
  throw new Error("Machine readiness configuration invalid");
};
function object(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return invalid();
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((k) => !keys.includes(k))) return invalid();
  return raw;
}
function number(value: unknown, min: number, max: number, fallback: number) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !(value >= min && value <= max))
    return invalid();
  return value;
}
// Device names are echoed back by the worker; keep them to plain labels.
const DEVICE = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,63}$/u;
function devices(value: unknown) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 16 ||
    value.some((v) => typeof v !== "string" || !DEVICE.test(v))
  )
    return invalid();
  return [...new Set(value as string[])];
}

export function parseReadinessConfig(value: unknown): ReadinessConfig {
  if (value === undefined) return DEFAULT_READINESS_CONFIG;
  const raw = object(value, [
    "version",
    "disk_min_free_gib",
    "network",
    "projects",
  ]);
  if (raw.version !== 1) return invalid();
  const d = DEFAULT_READINESS_CONFIG;
  const network = object(raw.network ?? {}, [
    "min_throughput_mb_s",
    "max_rtt_ms",
    "payload_mib",
  ]);
  const projects = object(
    raw.projects ?? {},
    Object.keys((raw.projects as object | undefined) ?? {}),
  );
  if (Object.keys(projects).length > 64) return invalid();
  return {
    disk_min_free_bytes:
      number(raw.disk_min_free_gib, 0, 65536, d.disk_min_free_bytes / GIB) *
      GIB,
    min_throughput_bytes_per_s:
      number(
        network.min_throughput_mb_s,
        0,
        10_000,
        d.min_throughput_bytes_per_s / 1e6,
      ) * 1e6,
    max_rtt_ms: number(network.max_rtt_ms, 1, 60_000, d.max_rtt_ms),
    payload_bytes: Math.round(
      number(network.payload_mib, 0, 64, d.payload_bytes / 1024 ** 2) *
        1024 ** 2,
    ),
    projects: Object.fromEntries(
      Object.entries(projects).map(([id, entry]) => {
        if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/u.test(id)) return invalid();
        const p = object(entry, ["android_avds", "ios_simulators"]);
        return [
          id,
          {
            android_avds: devices(p.android_avds),
            ios_simulators: devices(p.ios_simulators),
          },
        ];
      }),
    ),
  };
}

/**
 * Host-owned 0600 file beside runtime-workers.yaml, never project YAML. A bad
 * file never stops a check: the defaults apply and the patrol reports it.
 */
export function loadReadinessConfig(env: NodeJS.ProcessEnv = process.env): {
  readonly config: ReadinessConfig;
  readonly invalid: boolean;
} {
  const file = join(dirname(runtimeWorkersPath(env)), "machine-readiness.yaml");
  try {
    // Absent (including an absent configuration directory) means defaults, not a problem.
    if (!lstatSync(file, { throwIfNoEntry: false }))
      return { config: DEFAULT_READINESS_CONFIG, invalid: false };
    return {
      config: parseReadinessConfig(readOnboardingYaml(file)),
      invalid: false,
    };
  } catch {
    return { config: DEFAULT_READINESS_CONFIG, invalid: true };
  }
}
