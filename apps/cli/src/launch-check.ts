import { HARNESS_BINARY, resolveProfile } from "@cardigan/roles";
import { loadConfig, loadSecrets } from "./config.js";
import { CliError, EXIT } from "./errors.js";
import { findExecutable } from "./fs-io.js";
import type { CliIo } from "./io.js";
import type { LaunchPaths } from "./paths.js";

export async function checkProfile(
  paths: LaunchPaths,
  io: CliIo,
  profileName: string,
): Promise<number> {
  const config = await loadConfig(paths);
  const resolved = resolveProfile(config, profileName);
  const problems: string[] = [];
  const lines: string[] = [
    `启动配置：${profileName}（${resolved.profile.harness}）`,
  ];

  // Secrets file: permission first, because that is a safety issue.
  let secrets: Record<string, string> = {};
  try {
    secrets = await loadSecrets(paths, io);
    lines.push(`密钥文件：${paths.secretsFile}（已读取）`);
  } catch (error) {
    if (error instanceof CliError) {
      lines.push(`密钥文件：${paths.secretsFile}`);
      for (const detail of [error.message, ...error.details]) {
        lines.push(`  ${detail}`);
      }
      problems.push("密钥文件不可用");
    } else {
      throw error;
    }
  }

  const secretEnv = resolved.provider?.definition.secret_env ?? {};
  const secretEntries = Object.entries(secretEnv);
  if (secretEntries.length === 0) {
    lines.push("需要的密钥：（无）");
  } else {
    lines.push("需要的密钥（secrets.env 的键 → 传给 CLI 的变量）：");
    for (const [envName, secretKey] of secretEntries) {
      const present = (secrets[secretKey] ?? "").length > 0;
      lines.push(
        `  ${secretKey}${present ? "（已设置）" : "（缺失）"} → ${envName}`,
      );
      if (!present) {
        problems.push(`缺少密钥 ${secretKey}`);
      }
    }
  }

  const binary = HARNESS_BINARY[resolved.profile.harness];
  const executable = await findExecutable(binary, io.env.PATH, io.platform);
  if (executable === undefined) {
    lines.push(`CLI：${binary}（PATH 里没有）`);
    problems.push(`没有安装 ${binary}`);
  } else {
    lines.push(`CLI：${executable}`);
    const version = await probeVersion(executable, io);
    lines.push(`版本：${version ?? "（无法获取，可忽略）"}`);
  }

  io.stdout(lines.join("\n"));
  if (problems.length > 0) {
    io.stderr(`检查未通过：${problems.join("；")}`);
    return EXIT.failure;
  }
  return EXIT.ok;
}

async function probeVersion(
  executable: string,
  io: CliIo,
): Promise<string | undefined> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(io.env)) {
    if (value !== undefined) {
      env[name] = value;
    }
  }
  try {
    const captured = await io.captureCommand(executable, ["--version"], {
      cwd: io.cwd,
      env,
      timeoutMs: 5000,
    });
    if (captured.code !== 0) {
      return undefined;
    }
    const text = `${captured.stdout}\n${captured.stderr}`.trim();
    return text.split("\n")[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}
