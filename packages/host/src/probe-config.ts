import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import type { ProbeOperation, ProbePolicy } from "@cardigan/domain";
import { parse } from "yaml";

export type ProbeProfile = ProbePolicy;
export type ProbeProfiles = Readonly<
  Record<string, Partial<Record<"github" | "config", ProbeProfile>>>
>;
const invalid = (): never => {
  throw new Error("集成探针配置无效");
};
const object = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return invalid();
  return v as Record<string, unknown>;
};
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => {
  if (Object.keys(v).some((key) => !allowed.includes(key))) invalid();
};
const number = (v: unknown, fallback: number, max: number) => {
  const n = v ?? fallback;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > max)
    return invalid();
  return n;
};
/** No secrets, paths, commands, URLs or free-form environment in a probe profile. */
export function parseProbeProfiles(text: string): ProbeProfiles {
  const root = object(parse(text, { maxAliasCount: 0 }));
  keys(root, ["projects"]);
  const result: Record<
    string,
    Partial<Record<"github" | "config", ProbeProfile>>
  > = Object.create(null);
  for (const [project, raw] of Object.entries(object(root.projects))) {
    if (
      !/^[A-Za-z0-9_-]{1,80}$/u.test(project) ||
      ["__proto__", "constructor", "prototype"].includes(project)
    )
      invalid();
    const targets = object(raw);
    keys(targets, ["github", "config"]);
    const profiles: Partial<Record<"github" | "config", ProbeProfile>> = {};
    result[project] = profiles;
    for (const target of ["github", "config"] as const) {
      if (targets[target] === undefined) continue;
      const p = object(targets[target]);
      keys(
        p,
        target === "github"
          ? ["operations", "timeout_ms", "executor", "rest_budget_per_hour"]
          : ["operations", "timeout_ms"],
      );
      const ops = p.operations;
      if (
        !Array.isArray(ops) ||
        !ops.length ||
        new Set(ops).size !== ops.length ||
        !ops.every((op) =>
          ["smoke", "status", "cancel", "cleanup"].includes(op),
        )
      )
        invalid();
      if (
        target === "github" &&
        (typeof p.executor !== "string" ||
          !/^[a-z][a-z0-9_-]{0,31}$/u.test(p.executor))
      )
        invalid();
      profiles[target] = {
        operations: ops as ProbeOperation[],
        timeout_ms: number(
          p.timeout_ms,
          target === "github" ? 900_000 : 30_000,
          3_600_000,
        ),
        rest_budget_per_hour: number(p.rest_budget_per_hour, 120, 2000),
        ...(target === "github" ? { executor: p.executor as string } : {}),
      };
    }
  }
  return result;
}
/** A missing private file disables all probes. Invalid files fail closed. */
export function loadProbeProfiles(path: string): ProbeProfiles {
  const text = readPrivateConfig(path);
  if (text === undefined) return {};
  try {
    return parseProbeProfiles(text);
  } catch {
    return invalid();
  }
}
/** Host-only 0600 regular file owned by this account; undefined when absent. */
export function readPrivateConfig(path: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return invalid();
  }
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.uid !== process.getuid?.() ||
      (st.mode & 0o7777) !== 0o600 ||
      st.size > 65536
    )
      invalid();
    return readFileSync(fd, "utf8");
  } catch {
    return invalid();
  } finally {
    closeSync(fd);
  }
}
