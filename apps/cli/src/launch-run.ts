import {
  type CompiledLaunch,
  compileLaunch,
  redactLaunch,
} from "@cardigan/roles";
import { loadConfig, loadSecrets } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import { removeFileIfExists, writeFileWithMode } from "./fs-io.js";
import type { CliIo, SpawnedChild } from "./io.js";
import type { LaunchPaths } from "./paths.js";
import { newInstanceId, removeStaleSettingsFiles } from "./runtime-files.js";
import { forwardSignals } from "./signals.js";

export interface RunOptions {
  readonly profile: string;
  readonly cwd: string | undefined;
  readonly printOnly: boolean;
  readonly extra: readonly string[];
}

export interface RunDeps {
  /** Owner pid of this launch; embedded in generated file names. */
  readonly pid?: number;
  /** Random suffix for generated file names; defaults to 8 random bytes. */
  readonly randomHex?: string;
  /** Liveness probe used to find settings files of dead launches. */
  readonly isAlive?: (pid: number) => boolean;
}

export async function runProfile(
  paths: LaunchPaths,
  io: CliIo,
  parsed: RunOptions,
  deps: RunDeps = {},
): Promise<number> {
  const config = await loadConfig(paths, (message) => io.stderr(message));
  const secrets = await loadSecrets(paths, io);
  const instanceId = newInstanceId(deps.pid ?? process.pid, deps.randomHex);
  const compiled = compileLaunch({
    config,
    profile: parsed.profile,
    secrets,
    runtimeDir: paths.runtimeDir,
    extraArgs: parsed.extra,
    instanceId,
  });

  if (parsed.printOnly) {
    io.stdout(formatCompiled(redactLaunch(compiled, secrets)));
    return EXIT.ok;
  }

  return launchCompiled(
    compiled,
    io,
    parsed.cwd ?? io.cwd,
    paths.runtimeDir,
    deps,
  );
}

function formatCompiled(compiled: CompiledLaunch): string {
  const lines = [
    `启动配置：${compiled.profile}（${compiled.harness}）`,
    `命令：${compiled.command}`,
    "参数：",
    ...compiled.args.map((arg) => `  ${arg}`),
  ];

  const envNames = Object.keys(compiled.env).sort();
  lines.push(envNames.length === 0 ? "环境变量：（无）" : "环境变量：");
  for (const name of envNames) {
    lines.push(`  ${name}=${compiled.env[name] ?? ""}`);
  }

  if (compiled.files.length > 0) {
    lines.push("临时文件（启动前创建，权限 600，CLI 退出后删除）：");
    for (const file of compiled.files) {
      lines.push(`  ${file.path}`);
      for (const line of file.content.trimEnd().split("\n")) {
        lines.push(`    ${line}`);
      }
    }
  } else {
    lines.push("临时文件：（无）");
  }

  return lines.join("\n");
}

async function launchCompiled(
  compiled: CompiledLaunch,
  io: CliIo,
  cwd: string,
  runtimeDir: string,
  deps: RunDeps,
): Promise<number> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(io.env)) {
    if (value !== undefined) {
      env[name] = value;
    }
  }
  Object.assign(env, compiled.env);

  // A previous launch killed with SIGKILL cannot clean up after itself; do it
  // here so its settings file cannot hold secrets on disk indefinitely.
  if (compiled.files.length > 0) {
    await removeStaleSettingsFiles(runtimeDir, deps.isAlive);
  }

  for (const file of compiled.files) {
    await writeFileWithMode(file.path, file.content, file.mode);
  }

  // The OS can deliver SIGINT even during synchronous spawn: the child may
  // already be running while the parent has not returned from spawn yet.
  // Install handlers first, then resolve the forwarding target when called.
  let child: SpawnedChild | undefined;
  const disposeSignals = forwardSignals(
    { kill: (signal) => child?.kill(signal) },
    io.signals,
  );
  try {
    child = io.spawnInherit(compiled.command, compiled.args, { cwd, env });
    return await child.exit;
  } catch (error) {
    throw spawnFailure(compiled, error);
  } finally {
    disposeSignals();
    for (const file of compiled.files) {
      await removeFileIfExists(file.path);
    }
  }
}

function spawnFailure(compiled: CompiledLaunch, error: unknown): unknown {
  if (isEnoent(error)) {
    return new CliError(
      `没有找到 ${compiled.command}，先安装它（cardigan launch check ${compiled.profile} 会显示缺什么）`,
      EXIT.notInstalled,
    );
  }
  return error;
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
