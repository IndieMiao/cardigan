import type { z } from "zod";
import { getHarnessAdapter } from "./adapters/registry.js";
import { LaunchConfigError } from "./errors.js";
import type { CatalogEntry } from "./model-catalog.js";
import {
  type LaunchConfig,
  type LaunchProfileDefinition,
  launchConfigSchema,
  type ProviderDefinition,
  type ResolvedProfile,
} from "./schema-definition.js";

export type {
  BrowserLaunchDefinition,
  LaunchConfig,
  LaunchProfileDefinition,
  ProviderDefinition,
  ResolvedProfile,
} from "./schema-definition.js";

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
export function parseLaunchConfig(
  value: unknown,
  catalog: readonly CatalogEntry[] = [],
): LaunchConfig {
  return prepareLaunchConfig(value).resolve(catalog);
}

/** Validate local syntax before doing any catalog IO. Each resolution uses a fresh copy. */
export function prepareLaunchConfig(value: unknown) {
  const parsed = launchConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new LaunchConfigError(
      "invalid_config",
      "启动配置格式不正确",
      formatIssues(parsed.error),
    );
  }

  const raw = parsed.data;
  return {
    catalogPolicy: Object.keys(raw.models ?? {}).length
      ? (raw.model_catalog ?? {})
      : undefined,
    resolve: (catalog: readonly CatalogEntry[] = []) =>
      normalizeConfig(structuredClone(raw), catalog),
  };
}

function validateRoute(
  at: string,
  harness: LaunchProfileDefinition["harness"],
  provider: ProviderDefinition,
  name: string,
  details: string[],
) {
  const adapter = getHarnessAdapter(harness);
  adapter.validateRoute(at, provider, name, details);
  if (!provider.base_url) return;
  const key = adapter.endpointEnvKey?.(provider);
  if (
    key &&
    (key in provider.secret_env ||
      (key in provider.env && provider.env[key] !== provider.base_url))
  )
    details.push(`${at}: base_url 与 ${key} 的定义冲突`);
}

function normalizeConfig(
  config: LaunchConfig,
  catalog: readonly CatalogEntry[],
): LaunchConfig {
  const details: string[] = [];
  for (const [name, provider] of Object.entries(config.providers)) {
    const at = `providers.${name}`;
    if (!provider.harness && !provider.api)
      details.push(`${at}: 接入点需要 harness，跨 harness 共用时需要 api`);
    if (provider.harness)
      validateRoute(at, provider.harness, provider, name, details);
    else {
      if (provider.codex) validateRoute(at, "codex", provider, name, details);
      if (provider.pi) validateRoute(at, "pi", provider, name, details);
    }
    if (
      provider.codex &&
      ((provider.harness && provider.harness !== "codex") ||
        !provider.base_url ||
        (provider.api && provider.api !== "openai-responses"))
    )
      details.push(`${at}.codex 需要 codex 接入点和 base_url`);
    if (
      provider.pi &&
      (!provider.base_url || (provider.harness && provider.harness !== "pi"))
    )
      details.push(`${at}.pi 只用于 Pi 内联端点`);
    if (
      provider.base_url_env &&
      ((provider.harness && provider.harness !== "pi") || !provider.base_url)
    )
      details.push(`${at}.base_url_env 只用于 pi 的 base_url`);
    for (const envName of Object.keys(provider.secret_env)) {
      if (envName in provider.env) {
        details.push(
          `providers.${name}: ${envName} 既在 env 又在 secret_env 里，只能选一个`,
        );
      }
    }
  }

  const models = config.models ?? {};
  for (const [alias, model] of Object.entries(models)) {
    if (!Object.hasOwn(config.providers, model.provider))
      details.push(`models.${alias}: 引用了不存在的接入点 ${model.provider}`);
    const upstream = catalog.find(
      (entry) =>
        entry.provider === (model.catalog_provider ?? model.provider) &&
        entry.id === model.id,
    );
    model.cost ??= upstream?.cost;
    model.context_window ??= upstream?.context_window;
    model.max_output_tokens ??= upstream?.max_output_tokens;
    model.reasoning_efforts ??= upstream?.reasoning_efforts;
    if (!model.context_window)
      details.push(
        `models.${alias}.context_window: 目录中没有此模型的上下文窗口，请显式填写`,
      );
  }

  // Normalize once so direct profile readers (Run snapshot, diagnostics, upstream grouping)
  // see the same effective values as the compiler. Never mutate the decoded YAML.
  for (const [name, profile] of Object.entries(config.profiles)) {
    const at = `profiles.${name}`;
    const alias = profile.model;
    const model =
      alias && Object.hasOwn(models, alias) ? models[alias] : undefined;
    if (model) {
      if (profile.provider && profile.provider !== model.provider)
        details.push(`${at}.provider 与模型接入点不一致`);
      profile.model = model.id;
      profile.provider = model.provider;
      if (
        profile.effort &&
        model.reasoning_efforts &&
        !model.reasoning_efforts.includes(profile.effort)
      )
        details.push(`${at}.effort 不在模型支持的推理强度中`);
    }
    const configuredArgs = profile.args ?? [];
    const adapter = getHarnessAdapter(profile.harness);
    const provider =
      profile.provider && Object.hasOwn(config.providers, profile.provider)
        ? config.providers[profile.provider]
        : undefined;
    const context = { at, profile, model, provider, details };
    adapter.normalizeProfile(context);
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
      if (provider === undefined) {
        details.push(`${at}: 引用了不存在的接入点 ${profile.provider}`);
      } else if (adapter.inlineProfile && provider.base_url) {
        if (provider.harness && provider.harness !== profile.harness)
          details.push(`${at}: 与接入点的 harness 不一致`);
        if (!provider.harness)
          validateRoute(
            at,
            profile.harness,
            provider,
            profile.provider,
            details,
          );
        adapter.inlineProfile({ ...context, provider }, configuredArgs);
      } else if (!provider.harness) {
        validateRoute(at, profile.harness, provider, profile.provider, details);
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

  return config;
}

/** Look up a profile and its provider, with errors that name what is missing. */
export function resolveProfile(
  config: LaunchConfig,
  profileName: string,
): ResolvedProfile {
  const profile = Object.hasOwn(config.profiles, profileName)
    ? config.profiles[profileName]
    : undefined;
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
  const key = getHarnessAdapter(profile.harness).endpointEnvKey?.(definition);
  const route =
    key && definition.base_url
      ? {
          ...definition,
          env: { ...definition.env, [key]: definition.base_url },
        }
      : definition;
  return {
    name: profileName,
    profile,
    provider: { name: profile.provider, definition: route },
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

/** Check the complete candidate before either file becomes active. */
export function validateLaunchSecrets(
  config: LaunchConfig,
  secrets: Readonly<Record<string, string>>,
) {
  for (const profile of Object.keys(config.profiles)) {
    if (
      requiredSecretKeys(config, profile).some(
        (key) => !Object.hasOwn(secrets, key) || !secrets[key],
      )
    )
      throw new LaunchConfigError(
        "missing_secret",
        `启动配置 ${profile} 缺少所需的密钥`,
      );
  }
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
