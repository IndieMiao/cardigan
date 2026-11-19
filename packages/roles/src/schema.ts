import { z } from "zod";
import { LaunchConfigError } from "./errors.js";
import { HARNESSES } from "./harness.js";
import { type CatalogEntry, modelMetadata } from "./model-catalog.js";
import { piInlineArgsConflict, piThinkingLevels } from "./pi-model.js";

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
const positiveMillis = z.number().int().positive().max(2_147_483_647);
// Only a credential-free origin is accepted. Probes never send an HTTP request.
const probeOrigin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      value === url.origin
    );
  } catch {
    return false;
  }
}, "probe_url must be an http(s) origin without credentials, path, query or fragment");

/**
 * Provider = "接入点": which harness it belongs to, the endpoint it talks to,
 * and references to credentials. Credentials are only ever referenced by name:
 * `secret_env` maps an environment variable to a key in `secrets.env`.
 */
const endpoint = z.url({ protocol: /^https?$/ }).refine((value) => {
  const url = URL.parse(value);
  return (
    url !== null && !url.username && !url.password && !url.search && !url.hash
  );
}, "base_url must not contain credentials, query or fragment");
const providerSchema = z.strictObject({
  harness: harnessSchema.optional(),
  api: z
    .enum(["openai-responses", "anthropic-messages", "openai-completions"])
    .optional(),
  base_url: endpoint.optional(),
  /** Optional additional export; Pi reads the literal URL from its registry. */
  base_url_env: envVarSchema.optional(),
  pi: z.strictObject({ env_key: envVarSchema }).optional(),
  codex: z
    .strictObject({
      name: z.string().min(1).optional(),
      profile: nameSchema.optional(),
      env_key: envVarSchema.optional(),
      requires_openai_auth: z.boolean().optional(),
    })
    .optional(),
  env: z.record(envVarSchema, z.string()).default({}),
  secret_env: z.record(envVarSchema, z.string().min(1)).default({}),
  upstream: z
    .strictObject({ group: nameSchema, probe_url: probeOrigin.optional() })
    .optional(),
});

/**
 * Launch profile = "启动配置": harness, provider, model, permission mode, extra
 * arguments, auto-update switch, and the rest of what a harness CLI needs.
 */
const profileSchema = z.strictObject({
  harness: harnessSchema,
  provider: nameSchema.optional(),
  model: z.string().min(1).optional(),
  effort: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
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
  model_catalog: z
    .strictObject({
      max_age_ms: positiveMillis.optional(),
      max_bytes: z.number().int().positive().optional(),
      cache_max_bytes: z.number().int().positive().optional(),
      timeout_ms: positiveMillis.optional(),
    })
    .optional(),
  models: z
    .record(
      nameSchema,
      z.strictObject({
        id: z.string().min(1),
        provider: nameSchema,
        catalog_provider: nameSchema.optional(),
        ...modelMetadata.shape,
      }),
    )
    .optional(),
  profiles: z.record(nameSchema, profileSchema).default({}),
  browser: browserSchema.optional(),
  /** Freshness of read-only interaction features; not a line-failure threshold. */
  interaction_stale_after_ms: positiveMillis.optional(),
  upstream_health: z
    .strictObject({
      // No unapproved defaults: the host must explicitly set all probe timings.
      probe: z
        .strictObject({
          interval_ms: positiveMillis,
          timeout_ms: positiveMillis,
          stale_after_ms: positiveMillis,
        })
        .optional(),
      inactive_session_count: z
        .number()
        .int()
        .positive()
        .max(Number.MAX_SAFE_INTEGER)
        .default(3),
      inactivity_window_ms: positiveMillis.default(600_000),
      recurrence_window_ms: positiveMillis.default(900_000),
    })
    .optional(),
});

export type ProviderDefinition = z.infer<typeof providerSchema>;
export type LaunchProfileDefinition = z.infer<typeof profileSchema> & {
  /** Derived metadata for this exact alias, not a user-supplied registry. */
  pi_model?: z.infer<typeof modelMetadata>;
};
export type LaunchConfig = Omit<
  z.infer<typeof launchConfigSchema>,
  "profiles"
> & {
  profiles: Record<string, LaunchProfileDefinition>;
};
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

function inlineCodexProvider(
  name: string | undefined,
  provider: ProviderDefinition | undefined,
) {
  const config: NonNullable<LaunchProfileDefinition["config"]> = {};
  if (name && provider?.base_url) {
    const key = `model_providers.${name}`;
    config.model_provider = name;
    config[`${key}.name`] = provider.codex?.name ?? name;
    config[`${key}.base_url`] = provider.base_url;
    config[`${key}.wire_api`] = "responses";
    const secretNames = Object.keys(provider.secret_env);
    const envKey =
      provider.codex?.env_key ??
      (!provider.codex?.requires_openai_auth && secretNames.length === 1
        ? secretNames[0]
        : undefined);
    if (envKey) config[`${key}.env_key`] = envKey;
    if (provider.codex?.requires_openai_auth !== undefined)
      config[`${key}.requires_openai_auth`] =
        provider.codex.requires_openai_auth;
  }
  return config;
}

function endpointEnvKey(
  harness: LaunchProfileDefinition["harness"],
  provider: ProviderDefinition,
) {
  if (harness === "claude-code") return "ANTHROPIC_BASE_URL";
  return harness === "pi" ? provider.base_url_env : undefined;
}

function validateRoute(
  at: string,
  harness: LaunchProfileDefinition["harness"],
  provider: ProviderDefinition,
  name: string,
  details: string[],
) {
  if (
    provider.api &&
    ((harness === "codex" && provider.api !== "openai-responses") ||
      (harness === "claude-code" && provider.api !== "anthropic-messages"))
  )
    details.push(`${at}.api 与 harness.${harness} 不兼容`);
  if (!provider.base_url) return;
  if (harness === "codex") {
    if (
      name.includes(".") ||
      ["openai", "ollama", "lmstudio", "amazon-bedrock"].includes(name)
    )
      details.push(`${at}: 内联 Codex 接入点名不能含点或使用内置名称 ${name}`);
    if (provider.codex?.requires_openai_auth && provider.codex.env_key)
      details.push(`${at}.codex: requires_openai_auth 与 env_key 不能同时使用`);
  }
  if (harness === "pi" && !provider.api)
    details.push(`${at}: Pi 内联端点需要 api`);
  if (harness !== "claude-code") {
    const selected =
      harness === "pi" ? provider.pi?.env_key : provider.codex?.env_key;
    if (selected && !Object.hasOwn(provider.secret_env, selected))
      details.push(`${at}.${harness}.env_key 必须引用此接入点的 secret_env`);
    if (
      !selected &&
      !(harness === "codex" && provider.codex?.requires_openai_auth) &&
      Object.keys(provider.secret_env).length > 1
    )
      details.push(`${at}.${harness}.env_key: 多个凭据引用需要显式选择`);
  }
  if (harness === "codex") return;
  const key = endpointEnvKey(harness, provider);
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
      if (profile.harness === "pi") profile.provider_flag ??= model.provider;
      if (
        profile.effort &&
        model.reasoning_efforts &&
        !model.reasoning_efforts.includes(profile.effort)
      )
        details.push(`${at}.effort 不在模型支持的推理强度中`);
    }
    const configuredArgs = profile.args ?? [];
    if (profile.harness === "codex") {
      const provider =
        profile.provider && Object.hasOwn(config.providers, profile.provider)
          ? config.providers[profile.provider]
          : undefined;
      if (provider?.base_url) {
        // Inline routing has one owner. Free-form TOML/CLI overrides remain
        // available in legacy external profiles; other config is still allowed.
        if (
          Object.keys(profile.config ?? {}).some(
            (key) =>
              !/^[\w-]+(?:\.[\w-]+)*$/.test(key) ||
              /^(model_provider|model_providers|profiles|profile)(\.|$)/.test(
                key,
              ),
          ) ||
          profile.args?.some((arg) =>
            /^(-[cp]|--(config|profile|oss|local-provider)(=|$))/.test(arg),
          )
        )
          details.push(
            `${at}: 内联 Codex 路线不能由 config 或 args 重选接入点或凭据`,
          );
      }
      if (provider?.base_url || model || profile.effort) {
        profile.config = {
          ...inlineCodexProvider(profile.provider, provider),
          ...(profile.effort ? { model_reasoning_effort: profile.effort } : {}),
          ...(model?.context_window
            ? { model_context_window: model.context_window }
            : {}),
          ...profile.config,
        };
      }
    } else if (profile.effort) {
      profile.args = [
        profile.harness === "pi" ? "--thinking" : "--effort",
        profile.effort,
        ...(profile.args ?? []),
      ];
    }
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
      const provider = Object.hasOwn(config.providers, profile.provider)
        ? config.providers[profile.provider]
        : undefined;
      if (provider === undefined) {
        details.push(`${at}: 引用了不存在的接入点 ${profile.provider}`);
      } else if (profile.harness === "pi" && provider.base_url) {
        if (provider.harness && provider.harness !== "pi")
          details.push(`${at}: 与接入点的 harness 不一致`);
        if (!provider.harness)
          validateRoute(at, "pi", provider, profile.provider, details);
        if (
          !profile.model ||
          profile.agent_dir ||
          "PI_CODING_AGENT_DIR" in provider.env ||
          "PI_CODING_AGENT_DIR" in provider.secret_env ||
          provider.base_url_env === "PI_CODING_AGENT_DIR"
        )
          details.push(`${at}: Pi 内联端点需要模型并独占此启动的模型目录`);
        if (piInlineArgsConflict(configuredArgs))
          details.push(
            `${at}.args: Pi 内联模式请用 model、provider_flag、effort 和接入点凭据选择线路，不可用参数覆盖`,
          );
        if (profile.effort && !piThinkingLevels.includes(profile.effort))
          details.push(`${at}.effort: Pi 不能表达该推理强度`);
        if (
          model?.reasoning_efforts?.some(
            (e) => e !== "none" && !piThinkingLevels.includes(e),
          )
        )
          details.push(`${at}: Pi 不能表达模型声明的推理强度`);
        profile.provider_flag ??= profile.provider;
        if (model)
          profile.pi_model = {
            context_window: model.context_window,
            max_output_tokens: model.max_output_tokens,
            reasoning_efforts: model.reasoning_efforts,
          };
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
  const key = endpointEnvKey(profile.harness, definition);
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
