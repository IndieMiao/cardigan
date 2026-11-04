import {
  type CompiledLaunch,
  compileLaunch,
  redactLaunch,
} from "@cardigan/roles";
import { loadConfig, loadSecrets } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import { removeFileIfExists, writeFileWithMode } from "./fs-io.js";
import type { CliIo } from "./io.js";
import type { LaunchPaths } from "./paths.js";

export interface RunOptions {
  readonly profile: string;
  readonly cwd: string | undefined;
  readonly printOnly: boolean;
  readonly extra: readonly string[];
}

export async function runProfile(
  paths: LaunchPaths,
  io: CliIo,
  parsed: RunOptions,
): Promise<number> {
  const config = await loadConfig(paths);
  const secrets = await loadSecrets(paths, io);
  const compiled = compileLaunch({
    config,
    profile: parsed.profile,
    secrets,
    runtimeDir: paths.runtimeDir,
    extraArgs: parsed.extra,
  });

  if (parsed.printOnly) {
    io.stdout(formatCompiled(redactLaunch(compiled, secrets)));
    return EXIT.ok;
  }

  return launchCompiled(compiled, io, parsed.cwd ?? io.cwd);
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
): Promise<number> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(io.env)) {
    if (value !== undefined) {
      env[name] = value;
    }
  }
  Object.assign(env, compiled.env);

  try {
    for (const file of compiled.files) {
      await writeFileWithMode(file.path, file.content, file.mode);
    }
    return await io.spawnInherit(compiled.command, compiled.args, { cwd, env });
  } catch (error) {
    if (isEnoent(error)) {
      throw new CliError(
        `没有找到 ${compiled.command}，先安装它（cardigan launch check ${compiled.profile} 会显示缺什么）`,
        EXIT.notInstalled,
      );
    }
    throw error;
  } finally {
    for (const file of compiled.files) {
      await removeFileIfExists(file.path);
    }
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
