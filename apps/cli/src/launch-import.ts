import { importClaudeSettings } from "@cardigan/roles";
import { CliError, EXIT } from "./errors.js";
import {
  readSecretsFile,
  readTextIfExists,
  writeFileWithMode,
} from "./fs-io.js";
import type { CliIo } from "./io.js";
import type { LaunchPaths } from "./paths.js";

export async function importSettings(
  paths: LaunchPaths,
  io: CliIo,
  settingsPath: string,
  providerName: string,
): Promise<number> {
  const settingsText = await readTextIfExists(settingsPath);
  if (settingsText === undefined) {
    throw new CliError(`找不到 settings 文件：${settingsPath}`, EXIT.usage);
  }
  let settings: unknown;
  try {
    settings = JSON.parse(settingsText);
  } catch {
    throw new CliError(`${settingsPath} 不是合法的 JSON`, EXIT.usage);
  }

  const launchYaml = await readTextIfExists(paths.launchFile);
  const secretsEnv = await readSecretsFile(paths.secretsFile, io.platform);

  const result = importClaudeSettings({
    settings,
    providerName,
    ...(launchYaml === undefined ? {} : { launchYaml }),
    ...(secretsEnv === undefined ? {} : { secretsEnv }),
  });

  // Both files are written with 0600: launch.yaml references secret names and
  // endpoints, and secrets.env holds the values.
  await writeFileWithMode(paths.secretsFile, result.secretsEnv, 0o600);
  await writeFileWithMode(paths.launchFile, result.launchYaml, 0o600);

  io.stdout(
    [
      `已写入接入点 ${providerName}（claude-code）`,
      `launch.yaml：${paths.launchFile}`,
      `secrets.env：${paths.secretsFile}（权限 600）`,
      `留在 launch.yaml 的变量：${result.envKeys.join(", ") || "（无）"}`,
      `移进 secrets.env 的变量：${result.secretKeys.join(", ") || "（无）"}`,
      "密钥值没有打印，也没有进 git；核对后可删除原来的 settings 文件。",
    ].join("\n"),
  );
  return EXIT.ok;
}
