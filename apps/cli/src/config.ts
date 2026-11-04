import {
  type LaunchConfig,
  parseLaunchConfig,
  parseSecretsText,
} from "@cardigan/roles";
import { parse as parseYaml } from "yaml";
import { CliError, EXIT } from "./errors.js";
import { readSecretsFile, readTextIfExists } from "./fs-io.js";
import type { CliIo } from "./io.js";
import type { LaunchPaths } from "./paths.js";

export async function loadConfig(paths: LaunchPaths): Promise<LaunchConfig> {
  const text = await readTextIfExists(paths.launchFile);
  if (text === undefined) {
    throw new CliError(`找不到启动配置：${paths.launchFile}`, EXIT.usage, [
      "可以手写 providers/profiles，或用 cardigan launch import-claude-settings 生成",
    ]);
  }
  let decoded: unknown;
  try {
    decoded = parseYaml(text);
  } catch (error) {
    throw new CliError(`${paths.launchFile} 不是合法的 YAML`, EXIT.usage, [
      error instanceof Error ? error.message : String(error),
    ]);
  }
  return parseLaunchConfig(decoded ?? {});
}

export async function loadSecrets(
  paths: LaunchPaths,
  io: CliIo,
): Promise<Record<string, string>> {
  const text = await readSecretsFile(paths.secretsFile, io.platform);
  return text === undefined ? {} : parseSecretsText(text);
}
