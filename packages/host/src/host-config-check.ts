import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { loadMergeGateConfig } from "./merge-gate-config.js";
import { loadRunCapacityConfig } from "./run-capacity-config.js";
import { loadRuntimeWorkers } from "./runtime-workers-config.js";
import { WorkerMcpError } from "./worker-mcp.js";

/** C-792: the shared host YAML files whose errors stop work for every project. */
export const HOST_CONFIG_FILES = [
  "merge-gate.yaml",
  "run-capacity.yaml",
  "runtime-workers.yaml",
] as const;
export type HostConfigFile = (typeof HOST_CONFIG_FILES)[number];

export interface HostConfigFileResult {
  readonly file: HostConfigFile;
  /** missing: the loader's defaults apply (each loader treats absence as valid). */
  readonly status: "ok" | "missing" | "invalid";
  /** Fixed loader messages only; never file contents, commands or env values. */
  readonly errors: readonly string[];
}
export interface HostConfigCheck {
  readonly ok: boolean;
  readonly files: readonly HostConfigFileResult[];
}
export interface HostConfigProject {
  readonly id: string;
  readonly base_branch?: string;
}

const RUNTIME_WORKERS_INVALID =
  "runtime-workers.yaml 无效（须为本人所有、权限 0600、无硬链接的普通文件，字段须符合 worker 配置格式），所有远程 worker 不可用";

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true; // Let the loader report what it cannot read.
  }
}

/**
 * C-792: run the three existing loaders against one directory, exactly as the
 * server would at startup. Read-only; nothing is written or cached as host state.
 */
export async function checkHostConfig(input: {
  readonly configDir: string;
  readonly dataDir: string;
  readonly projects: readonly HostConfigProject[];
}): Promise<HostConfigCheck> {
  const configDir = resolve(input.configDir);
  const env: Record<string, string | undefined> = {};
  const files: HostConfigFileResult[] = [];
  const result = async (
    file: HostConfigFile,
    errors: () => Promise<readonly string[]>,
  ) => {
    if (!(await exists(join(configDir, file)))) {
      files.push({ file, status: "missing", errors: [] });
      return;
    }
    const found = [...(await errors())];
    files.push({
      file,
      status: found.length ? "invalid" : "ok",
      errors: found,
    });
  };
  await result(
    "merge-gate.yaml",
    async () =>
      (
        await loadMergeGateConfig({
          configDir,
          dataDir: input.dataDir,
          projectIds: input.projects.map((project) => project.id),
          baseBranches: Object.fromEntries(
            input.projects.map((p) => [p.id, p.base_branch ?? "main"]),
          ),
          env,
        })
      ).errors,
  );
  await result(
    "run-capacity.yaml",
    async () => (await loadRunCapacityConfig({ configDir, env })).errors,
  );
  await result("runtime-workers.yaml", async () => {
    try {
      loadRuntimeWorkers(
        input.dataDir,
        join(configDir, "runtime-workers.yaml"),
      );
      return [];
    } catch (error) {
      return [
        error instanceof WorkerMcpError
          ? `${RUNTIME_WORKERS_INVALID}（${error.code}）`
          : RUNTIME_WORKERS_INVALID,
      ];
    }
  });
  return { ok: files.every((file) => file.status !== "invalid"), files };
}

interface Snapshot {
  readonly file: HostConfigFile;
  readonly content?: string;
  readonly error?: string;
}

/** The same safety rules as the loaders, so a private copy cannot hide them. */
async function readSafely(
  dir: string,
  file: HostConfigFile,
): Promise<Snapshot> {
  const path = join(dir, file);
  const unsafe = { file, error: `无法安全读取 ${file}` };
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { file }
      : unsafe;
  }
  try {
    const info = await handle.stat();
    const uid = process.getuid?.();
    const workers = file === "runtime-workers.yaml";
    if (
      !info.isFile() ||
      info.size > 1024 * 1024 ||
      (workers
        ? info.uid !== uid || info.nlink !== 1 || (info.mode & 0o7777) !== 0o600
        : ![0, uid].includes(info.uid) || info.mode & 0o022)
    )
      return unsafe;
    if (!workers)
      for (let parent = dirname(path); ; parent = dirname(parent)) {
        const entry = await lstat(parent);
        if (
          !entry.isDirectory() ||
          ![0, uid].includes(entry.uid) ||
          (entry.mode & 0o022 && !(entry.mode & 0o1000))
        )
          return unsafe;
        if (parent === dirname(parent)) break;
      }
    return { file, content: await handle.readFile("utf8") };
  } catch {
    return unsafe;
  } finally {
    await handle.close();
  }
}

function fingerprintOf(snapshots: readonly Snapshot[]): string {
  const hash = createHash("sha256");
  for (const s of snapshots)
    hash.update(
      `${JSON.stringify([s.file, s.error ?? null, s.content ?? null])}\n`,
    );
  return hash.digest("hex");
}

/**
 * C-792: change detector for the deployment trial. Unreadable or unsafe files
 * are part of the fingerprint, so fixing permissions also triggers a retry.
 */
export async function hostConfigFingerprint(configDir: string) {
  return fingerprintOf(
    await Promise.all(
      HOST_CONFIG_FILES.map((file) => readSafely(resolve(configDir), file)),
    ),
  );
}

/**
 * C-792: copy the real host configuration into a fresh private directory for
 * a trial load. The real files are only read. A file the loaders would refuse
 * to read is reported here instead of being copied with safe permissions.
 */
export async function snapshotHostConfig(
  configDir: string,
  target: string,
): Promise<{
  readonly errors: readonly string[];
  readonly fingerprint: string;
}> {
  const snapshots = await Promise.all(
    HOST_CONFIG_FILES.map((file) => readSafely(resolve(configDir), file)),
  );
  for (const s of snapshots)
    if (s.content !== undefined) {
      const path = join(target, s.file);
      await writeFile(path, s.content, { mode: 0o600, flag: "wx" });
      await chmod(path, 0o600); // Exactly what the worker loader requires.
    }
  return {
    errors: snapshots.flatMap((s) => (s.error ? [s.error] : [])),
    fingerprint: fingerprintOf(snapshots),
  };
}
