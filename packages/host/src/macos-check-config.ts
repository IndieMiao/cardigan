import { parse } from "yaml";
import { readPrivateConfig } from "./probe-config.js";

/** C-611: fixed workflow; the host configuration can only tune limits. */
export const MACOS_CHECK_WORKFLOW =
  ".github/workflows/cardigan-macos-check.yml";
export interface MacosCheckProfile {
  readonly enabled: boolean;
  /** GitHub executor whose App and repository dispatch the macOS workflow. */
  readonly executor?: string;
  /** Requests for the same delivery head, including the first run. */
  readonly max_runs_per_candidate: number;
  readonly max_concurrent: number;
  /** Host supervision from request to terminal result, queueing included. */
  readonly timeout_ms: number;
  readonly rest_budget_per_hour: number;
}
export const MACOS_CHECK_DEFAULTS: MacosCheckProfile = {
  enabled: true,
  max_runs_per_candidate: 3,
  max_concurrent: 2,
  timeout_ms: 60 * 60_000,
  rest_budget_per_hour: 120,
};
export type MacosCheckProfiles = Readonly<
  Record<string, Partial<MacosCheckProfile>>
>;
const invalid = (): never => {
  throw new Error("macOS 检查配置无效");
};
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : invalid();
const integer = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max
    ? v
    : invalid();
/** Optional overrides per project; no paths, commands, credentials or workflow names. */
export function parseMacosCheckProfiles(text: string): MacosCheckProfiles {
  const root = object(parse(text, { maxAliasCount: 0 }) ?? {});
  if (Object.keys(root).some((key) => key !== "projects")) invalid();
  const result: Record<string, Partial<MacosCheckProfile>> = Object.create(
    null,
  );
  for (const [project, raw] of Object.entries(object(root.projects ?? {}))) {
    if (
      !/^[A-Za-z0-9_-]{1,80}$/u.test(project) ||
      ["__proto__", "constructor", "prototype"].includes(project)
    )
      invalid();
    const p = object(raw);
    const known = [
      "enabled",
      "executor",
      "max_runs_per_candidate",
      "max_concurrent",
      "timeout_ms",
      "rest_budget_per_hour",
    ];
    if (Object.keys(p).some((key) => !known.includes(key))) invalid();
    const profile: Record<string, unknown> = {};
    if (p.enabled !== undefined)
      profile.enabled = typeof p.enabled === "boolean" ? p.enabled : invalid();
    if (p.executor !== undefined)
      profile.executor =
        typeof p.executor === "string" &&
        /^[a-z][a-z0-9_-]{0,31}$/u.test(p.executor)
          ? p.executor
          : invalid();
    if (p.max_runs_per_candidate !== undefined)
      profile.max_runs_per_candidate = integer(p.max_runs_per_candidate, 1, 20);
    if (p.max_concurrent !== undefined)
      profile.max_concurrent = integer(p.max_concurrent, 1, 8);
    if (p.timeout_ms !== undefined)
      profile.timeout_ms = integer(p.timeout_ms, 600_000, 3 * 3_600_000);
    if (p.rest_budget_per_hour !== undefined)
      profile.rest_budget_per_hour = integer(p.rest_budget_per_hour, 10, 2000);
    result[project] = profile as Partial<MacosCheckProfile>;
  }
  return result;
}
/** A missing file keeps the defaults; an invalid file disables macOS checks. */
export function loadMacosCheckProfiles(
  path: string,
): MacosCheckProfiles | undefined {
  try {
    const text = readPrivateConfig(path);
    return text === undefined ? {} : parseMacosCheckProfiles(text);
  } catch {
    return undefined;
  }
}
