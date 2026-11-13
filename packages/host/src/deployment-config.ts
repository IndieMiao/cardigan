import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseDocument } from "yaml";

export interface DeploymentConfig {
  readonly enabled: boolean;
  readonly initial_release: string;
  readonly initial_sha: string;
  readonly ready_timeout_ms: number;
  readonly stop_timeout_ms: number;
  readonly poll_interval_ms: number;
  readonly build_timeout_ms: number;
}

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
  for (const key of keys.filter((k) => k.endsWith("_ms")))
    if (
      !Number.isSafeInteger(value[key]) ||
      Number(value[key]) < 1 ||
      Number(value[key]) > 2147483647
    )
      throw new Error("Invalid deployment timeout");
  return {
    ...value,
    enabled: value.enabled ?? true,
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
