import { readFileSync } from "node:fs";
import { loadModelLaunchConfig, parseCachedLaunchConfig } from "@cardigan/host";
import {
  type LaunchConfig,
  parseSecretsText,
  reportLaunchWarnings,
} from "@cardigan/roles";
import { parse as parseYaml } from "yaml";
import { CliError, EXIT } from "./errors.js";
import { readSecretsFile, readTextIfExists } from "./fs-io.js";
import type { CliIo } from "./io.js";
import type { LaunchPaths } from "./paths.js";

export async function loadConfig(
  paths: LaunchPaths,
  report?: (message: string) => void,
): Promise<LaunchConfig> {
  const text = await readTextIfExists(paths.launchFile);
  if (text === undefined) {
    throw new CliError(`找不到启动配置：${paths.launchFile}`, EXIT.usage, [
      "可以手写 providers/profiles，或用 cardigan launch import-claude-settings 生成",
    ]);
  }
  const config = await loadModelLaunchConfig(
    decodeConfig(text, paths),
    paths.dataDir,
  );
  if (report) reportLaunchWarnings(config, report);
  return config;
}

/** Keep read-only synchronous CLI consumers synchronous; absence is optional. */
export function loadOptionalConfigSync(
  paths: LaunchPaths,
): LaunchConfig | undefined {
  let text: string;
  try {
    text = readFileSync(paths.launchFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseCachedLaunchConfig(decodeConfig(text, paths), paths.dataDir);
}

function decodeConfig(text: string, paths: LaunchPaths): unknown {
  let decoded: unknown;
  try {
    decoded = parseYaml(text, { prettyErrors: false });
  } catch (error) {
    throw new CliError(`${paths.launchFile} 不是合法的 YAML`, EXIT.usage, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  if (decoded == null) throw new CliError("启动配置为空", EXIT.usage);
  return decoded;
}

export async function loadSecrets(
  paths: LaunchPaths,
  io: CliIo,
): Promise<Record<string, string>> {
  const text = await readSecretsFile(paths.secretsFile, io.platform);
  return text === undefined ? {} : parseSecretsText(text);
}
