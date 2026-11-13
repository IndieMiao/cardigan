import { z } from "zod";
import { LaunchConfigError } from "./errors.js";
import { HARNESSES } from "./harness.js";

const nameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "name must start with a lowercase letter or digit and use only a-z 0-9 . _ -",
  );

const envVarSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "not a valid environment variable name");

const harnessSchema = z.enum(HARNESSES);

/**
 * Provider = "接入点": which harness it belongs to, the endpoint it talks to,
 * and references to credentials. Credentials are only ever referenced by name:
 * `secret_env` maps an environment variable to a key in `secrets.env`.
 */
const providerSchema = z.strictObject({
  harness: harnessSchema,
  env: z.record(envVarSchema, z.string()).default({}),
  secret_env: z.record(envVarSchema, z.string().min(1)).default({}),
});

/**
 * Launch profile = "启动配置": harness, provider, model, permission mode, extra
 * arguments, auto-update switch, and the rest of what a harness CLI needs.
 */
const profileSchema = z.strictObject({
  harness: harnessSchema,
  provider: nameSchema.optional(),
  model: z.string().min(1).optional(),
  /** Pi only: value for `--provider`. */
  provider_flag: z.string().min(1).optional(),
  /** Claude Code only: value for `--permission-mode`. */
  permission_mode: z.string().min(1).optional(),
  /** Claude Code only: when false, Cardigan disables the auto-updater. */
  auto_update: z.boolean().optional(),
  /** Pi only: value for `PI_CODING_AGENT_DIR`, expected outside the repository. */
  agent_dir: z.string().min(1).optional(),
  /** Codex only: `-c key=value` overrides, in insertion order. */
  config: z
    .record(z.string().min(1), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
  /** Extra arguments appended after Cardigan's own. */
  args: z.array(z.string()).optional(),
});

const absolutePathSchema = z
  .string()
  .min(1)
  .regex(/^\/[^\0\n]*$/u, "must be an absolute path");

/**
 * P2a-14 ⑧: the host's local headless browser for roles with the `browser`
 * capability. Host policy only (launch.yaml lives outside every project
 * repository); without this section no Assignment gets a browser.
 */
const browserSchema = z.strictObject({
  /** Installed `@playwright/mcp` CLI, e.g. `/opt/playwright-mcp-<v>/bin/mcp-server-playwright`. */
  command: absolutePathSchema,
  /** Read-only shared Chromium, exported as `PLAYWRIGHT_BROWSERS_PATH`. */
  browsers_path: absolutePathSchema,
  // No free-form `args`: extra flags could switch the server to HTTP
  // (`--port`), attach an existing browser (`--extension`) or move the
  // browser and output directory, undoing the fixed stdio/isolated launch.
});

const launchConfigSchema = z.strictObject({
  providers: z.record(nameSchema, providerSchema).default({}),
  profiles: z.record(nameSchema, profileSchema).default({}),
  browser: browserSchema.optional(),
});

export type ProviderDefinition = z.infer<typeof providerSchema>;
export type LaunchProfileDefinition = z.infer<typeof profileSchema>;
export type LaunchConfig = z.infer<typeof launchConfigSchema>;
export type BrowserLaunchDefinition = z.infer<typeof browserSchema>;

export interface ResolvedProfile {
  readonly name: string;
  readonly profile: LaunchProfileDefinition;
  readonly provider?: {
    readonly name: string;
    readonly definition: ProviderDefinition;
  };
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

/**
 * Validate a decoded `launch.yaml` value (already parsed from YAML or JSON) and
 * return a typed config.
 *
 * Field placement is validated per harness: each harness only understands a
 * subset of the optional fields, and a field aimed at the wrong harness is an
 * error rather than a silent no-op.
 */
export function parseLaunchConfig(value: unknown): LaunchConfig {
  const parsed = launchConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new LaunchConfigError(
      "invalid_config",
      "启动配置格式不正确",
      formatIssues(parsed.error),
    );
  }

  const details: string[] = [];
  for (const [name, provider] of Object.entries(parsed.data.providers)) {
    for (const envName of Object.keys(provider.secret_env)) {
      if (envName in provider.env) {
        details.push(
          `providers.${name}: ${envName} 既在 env 又在 secret_env 里，只能选一个`,
        );
      }
    }
  }

  for (const [name, profile] of Object.entries(parsed.data.profiles)) {
    const at = `profiles.${name}`;
    if (profile.harness !== "pi") {
      if (profile.provider_flag !== undefined) {
        details.push(`${at}: provider_flag 只用于 pi`);
      }
      if (profile.agent_dir !== undefined) {
        details.push(`${at}: agent_dir 只用于 pi`);
      }
    }
    if (
      profile.harness !== "claude-code" &&
      profile.permission_mode !== undefined
    ) {
      details.push(`${at}: permission_mode 只用于 claude-code`);
    }
    if (
      profile.harness !== "claude-code" &&
      profile.auto_update !== undefined
    ) {
      details.push(`${at}: auto_update 只用于 claude-code`);
    }
    if (profile.harness !== "codex" && profile.config !== undefined) {
      details.push(`${at}: config 只用于 codex`);
    }
    if (profile.provider !== undefined) {
      const provider = parsed.data.providers[profile.provider];
      if (provider === undefined) {
        details.push(`${at}: 引用了不存在的接入点 ${profile.provider}`);
      } else if (provider.harness !== profile.harness) {
        details.push(
          `${at}: harness 是 ${profile.harness}，但接入点 ${profile.provider} 是 ${provider.harness}`,
        );
      }
    }
  }

  if (details.length > 0) {
    throw new LaunchConfigError(
      "invalid_config",
      "启动配置里有互相矛盾的字段",
      details,
    );
  }

  return parsed.data;
}

/** Look up a profile and its provider, with errors that name what is missing. */
export function resolveProfile(
  config: LaunchConfig,
  profileName: string,
): ResolvedProfile {
  const profile = config.profiles[profileName];
  if (profile === undefined) {
    throw new LaunchConfigError(
      "unknown_profile",
      `没有名为 ${profileName} 的启动配置`,
      Object.keys(config.profiles),
    );
  }
  if (profile.provider === undefined) {
    return { name: profileName, profile };
  }
  const definition = config.providers[profile.provider];
  if (definition === undefined) {
    throw new LaunchConfigError(
      "unknown_provider",
      `启动配置 ${profileName} 引用了不存在的接入点 ${profile.provider}`,
      Object.keys(config.providers),
    );
  }
  return {
    name: profileName,
    profile,
    provider: { name: profile.provider, definition },
  };
}

/**
 * Secret keys (`secrets.env` names) the profile needs, without duplicates.
 * `launch check` uses this to report missing keys without holding any value.
 */
export function requiredSecretKeys(
  config: LaunchConfig,
  profileName: string,
): string[] {
  const resolved = resolveProfile(config, profileName);
  const keys = new Set<string>();
  for (const key of Object.values(
    resolved.provider?.definition.secret_env ?? {},
  )) {
    keys.add(key);
  }
  return [...keys];
}

/**
 * Parse a `secrets.env` file: one `KEY=VALUE` per line, `#` comments and blank
 * lines ignored. Surrounding quotes on values are stripped. Values are never
 * logged by this module.
 */
export function parseSecretsText(text: string): Record<string, string> {
  const secrets: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) {
      throw new LaunchConfigError("invalid_config", "secrets.env 格式不正确", [
        `第 ${index + 1} 行不是 KEY=VALUE`,
      ]);
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new LaunchConfigError(
        "invalid_config",
        "secrets.env 里有非法的变量名",
        [`第 ${index + 1} 行`],
      );
    }
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    secrets[key] = value;
  }
  return secrets;
}
