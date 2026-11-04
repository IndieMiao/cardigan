import { parseDocument, parse as parseYaml, stringify } from "yaml";
import { LaunchConfigError } from "./errors.js";
import type { ProviderDefinition } from "./schema.js";
import { parseSecretsText } from "./schema.js";

/** Name → value, in the order the settings file listed them. */
const SECRET_NAME_PATTERN =
  /(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i;

export interface ImportClaudeSettingsInput {
  /** Parsed JSON content of an existing Claude Code settings file. */
  readonly settings: unknown;
  readonly providerName: string;
  /** Current `launch.yaml` text, if the file exists. */
  readonly launchYaml?: string;
  /** Current `secrets.env` text, if the file exists. */
  readonly secretsEnv?: string;
}

export interface ImportClaudeSettingsResult {
  readonly providerName: string;
  /** Env var names that stay in `launch.yaml`, sorted. */
  readonly envKeys: readonly string[];
  /** Env var names whose values move to `secrets.env`, sorted. */
  readonly secretKeys: readonly string[];
  readonly launchYaml: string;
  /** New `secrets.env` content. Contains secret values: write it, never print it. */
  readonly secretsEnv: string;
  readonly provider: ProviderDefinition;
}

/**
 * Convert an existing Claude Code settings file into a provider definition.
 *
 * Pure: takes and returns file contents. Variables whose name contains TOKEN,
 * KEY, SECRET, PASSWORD, PASSWD, CREDENTIAL or AUTH become secret references
 * in `launch.yaml` and values in `secrets.env`; everything else stays in
 * `launch.yaml`. Existing content of
 * both files is preserved.
 */
export function importClaudeSettings(
  input: ImportClaudeSettingsInput,
): ImportClaudeSettingsResult {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(input.providerName)) {
    throw new LaunchConfigError("invalid_import", "接入点名字不合法", [
      `收到 ${JSON.stringify(input.providerName)}；只允许小写字母、数字和 . _ -`,
    ]);
  }

  const env = readSettingsEnv(input.settings);

  const envEntries: Array<[string, string]> = [];
  const secretEntries: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_NAME_PATTERN.test(name)) {
      if (value.length === 0) {
        throw new LaunchConfigError("invalid_import", `${name} 的值是空的`);
      }
      if (value.includes('"') || value.includes("\n") || value.includes("\r")) {
        throw new LaunchConfigError(
          "invalid_import",
          `${name} 的值里有引号或换行，请手动写进 secrets.env`,
        );
      }
      secretEntries.push([name, value]);
    } else {
      envEntries.push([name, value]);
    }
  }

  if (envEntries.length === 0 && secretEntries.length === 0) {
    throw new LaunchConfigError(
      "invalid_import",
      "settings 文件里没有可导入的 env",
    );
  }

  const provider: ProviderDefinition = {
    harness: "claude-code",
    env: Object.fromEntries(envEntries),
    secret_env: Object.fromEntries(secretEntries.map(([name]) => [name, name])),
  };

  return {
    providerName: input.providerName,
    envKeys: envEntries.map(([name]) => name),
    secretKeys: secretEntries.map(([name]) => name),
    launchYaml: writeLaunchYaml(input.launchYaml, input.providerName, provider),
    secretsEnv: mergeSecretsEnv(
      input.secretsEnv,
      Object.fromEntries(secretEntries),
    ),
    provider,
  };
}

function readSettingsEnv(settings: unknown): Record<string, string> {
  if (typeof settings !== "object" || settings === null) {
    throw new LaunchConfigError(
      "invalid_import",
      "settings 文件不是 JSON 对象",
    );
  }
  const env = (settings as { env?: unknown }).env;
  if (env === undefined) {
    throw new LaunchConfigError(
      "invalid_import",
      "settings 文件里没有 env 字段",
      ["只导入 settings 的 env 对象；其他字段留给 Claude Code 自己"],
    );
  }
  if (typeof env !== "object" || env === null || Array.isArray(env)) {
    throw new LaunchConfigError("invalid_import", "settings 的 env 不是对象");
  }

  const entries: Record<string, string> = {};
  for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new LaunchConfigError("invalid_import", "env 里有非法的变量名", [
        name,
      ]);
    }
    if (typeof value !== "string") {
      throw new LaunchConfigError("invalid_import", `env.${name} 不是字符串`);
    }
    entries[name] = value;
  }
  return entries;
}

/**
 * Insert the provider into `launch.yaml` while keeping comments and the rest of
 * the file intact. Refuses to overwrite an existing provider.
 */
function writeLaunchYaml(
  existingText: string | undefined,
  providerName: string,
  provider: ProviderDefinition,
): string {
  if (existingText === undefined || existingText.trim().length === 0) {
    // A fresh file: emit block style so it stays readable and hand-editable.
    return stringify({
      providers: { [providerName]: provider },
      profiles: {},
    });
  }

  const document = parseDocument(existingText);

  if (document.errors.length > 0) {
    throw new LaunchConfigError(
      "invalid_import",
      "现有的 launch.yaml 无法解析，未做修改",
      document.errors.map((error) => error.message),
    );
  }

  const existing = parseYaml(existingText ?? "") as {
    providers?: Record<string, unknown>;
  } | null;
  if (existing !== null && typeof existing === "object") {
    const providers = existing.providers;
    if (
      providers !== undefined &&
      typeof providers === "object" &&
      providers !== null &&
      providerName in providers
    ) {
      throw new LaunchConfigError(
        "invalid_import",
        `接入点 ${providerName} 已经存在，未覆盖`,
        ["换一个 --provider 名字，或先手动删除原配置"],
      );
    }
  }

  document.setIn(["providers", providerName], {
    harness: provider.harness,
    env: { ...provider.env },
    secret_env: { ...provider.secret_env },
  });

  const text = document.toString();
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Merge imported secret values into `secrets.env`, keeping unrelated lines and
 * comments. Values are written raw when safe, quoted otherwise.
 */
function mergeSecretsEnv(
  existingText: string | undefined,
  entries: Readonly<Record<string, string>>,
): string {
  // Validate the current file first so a broken file is never rewritten.
  parseSecretsText(existingText ?? "");

  const pending = new Map(Object.entries(entries));
  const kept: string[] = [];

  for (const line of (existingText ?? "").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const name = match?.[1];
    if (name !== undefined && pending.has(name)) {
      kept.push(`${name}=${formatSecretValue(pending.get(name) ?? "")}`);
      pending.delete(name);
      continue;
    }
    kept.push(line);
  }

  const tail = [...pending.entries()].map(
    ([name, value]) => `${name}=${formatSecretValue(value)}`,
  );

  const lines = [...kept];
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }
  lines.push(...tail);

  return `${lines.join("\n")}\n`;
}

function formatSecretValue(value: string): string {
  if (/^[A-Za-z0-9._:@/+=~-]*$/.test(value)) {
    return value;
  }
  return `"${value}"`;
}
