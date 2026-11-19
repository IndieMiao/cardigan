import { join } from "node:path";
import { HARNESS_CATALOG } from "@cardigan/domain";
import type { BrowserServer } from "../assignment-types.js";
import { BROWSER_MCP_SERVER_NAME, TOKEN_ENV_VAR } from "../assignment-types.js";
import type {
  LaunchProfileDefinition,
  ProviderDefinition,
} from "../schema-definition.js";
import { readCodexContext } from "./codex-context.js";
import { plain } from "./effort.js";
import { onlyKey, validateSecretKey } from "./provider.js";
import type { HarnessAdapter } from "./types.js";

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

/**
 * `config.toml` for Codex: the Card server with an env-var token reference and
 * per-tool approval, plus the Core Prompt as the model instruction file.
 * `model_instructions_file` replaces Codex's own instructions, so the Core
 * Prompt carries the full protocol (§M2.4).
 */
function codexConfig(
  serverName: string,
  url: string,
  tools: readonly string[],
  coreFile: string,
  trustedPaths: readonly string[],
  browser: BrowserServer | undefined,
): string {
  const lines = [
    `model_instructions_file = ${JSON.stringify(coreFile)}`,
    "",
    "[features]",
    "shell_tool = true",
    "",
    `[mcp_servers.${serverName}]`,
    `url = ${JSON.stringify(url)}`,
    `bearer_token_env_var = ${JSON.stringify(TOKEN_ENV_VAR)}`,
    "",
  ];
  for (const tool of tools) {
    lines.push(
      `[mcp_servers.${serverName}.tools.${tool}]`,
      'approval_mode = "approve"',
      "",
    );
  }
  if (browser !== undefined) {
    // Codex 0.161: one approval mode for every tool of the local browser.
    lines.push(
      `[mcp_servers.${BROWSER_MCP_SERVER_NAME}]`,
      `command = ${JSON.stringify(browser.command)}`,
      `args = [${browser.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
      'default_tools_approval_mode = "approve"',
      "",
      `[mcp_servers.${BROWSER_MCP_SERVER_NAME}.env]`,
      ...Object.entries(browser.env).map(
        ([name, value]) => `${name} = ${JSON.stringify(value)}`,
      ),
      "",
    );
  }
  // Codex 0.161 resolves a linked worktree's project root through its common dir.
  // Never trust the worktrees/repos parent or inherit the host user's config.
  for (const path of new Set(trustedPaths)) {
    lines.push(
      `[projects.${JSON.stringify(path)}]`,
      'trust_level = "trusted"',
      "",
    );
  }
  return `${lines.join("\n")}`;
}

/** Codex `-c` values: strings are quoted, numbers and booleans stay literal. */
function formatCodexConfigValue(value: string | number | boolean): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
/** Codex `-c` values are TOML; a bare word is taken as a string. */
function codexValue(raw: string): string | undefined {
  const quoted = /^"([^"\\]*)"$|^'([^']*)'$/u.exec(raw);
  return plain(quoted ? (quoted[1] ?? quoted[2]) : raw);
}

export const codex: HarnessAdapter = {
  ...HARNESS_CATALOG.codex,
  probeCredential(p) {
    return p.codex?.requires_openai_auth
      ? undefined
      : (p.codex?.env_key ?? onlyKey(Object.keys(p.secret_env)));
  },
  validateRoute(at, provider, name, details) {
    if (provider.api && provider.api !== "openai-responses")
      details.push(`${at}.api 与 harness.codex 不兼容`);
    if (!provider.base_url) return;
    if (
      name.includes(".") ||
      ["openai", "ollama", "lmstudio", "amazon-bedrock"].includes(name)
    )
      details.push(`${at}: 内联 Codex 接入点名不能含点或使用内置名称 ${name}`);
    if (provider.codex?.requires_openai_auth && provider.codex.env_key)
      details.push(`${at}.codex: requires_openai_auth 与 env_key 不能同时使用`);
    validateSecretKey(
      at,
      "codex",
      provider,
      provider.codex?.env_key,
      !!provider.codex?.requires_openai_auth,
      details,
    );
  },
  normalizeProfile({ at, profile, model, provider, details }) {
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
  },
  versionArgs: ["--version"],
  contextSource: "codex_rollout:last_token_usage",
  readContext: readCodexContext,
  compile({ resolved, providerEnv, secretEnv, profileArgs, extraArgs }) {
    // Codex keeps its own config; Cardigan only composes arguments:
    // `--profile`, `-c key=value` overrides, `-m`, then extra arguments.
    const args: string[] = [];
    const provider = resolved.provider;
    const external = provider?.definition.base_url
      ? provider.definition.codex?.profile
      : provider?.name;
    if (external) args.push("--profile", external);
    if (resolved.profile.model !== undefined) {
      args.push("-m", resolved.profile.model);
    }
    for (const [key, value] of Object.entries(resolved.profile.config ?? {})) {
      args.push("-c", `${key}=${formatCodexConfigValue(value)}`);
    }
    args.push(...profileArgs, ...extraArgs);

    return {
      harness: "codex",
      profile: resolved.name,
      command: this.binary,
      args,
      env: { ...providerEnv, ...secretEnv },
      files: [],
      secretEnvKeys: Object.keys(secretEnv),
    };
  },
  configureAssignment({
    input,
    sessionDir,
    coreFile,
    serverName,
    browser,
    harnessEnv,
    harnessFiles,
  }) {
    // Codex reads config.toml from CODEX_HOME; the file holds no credentials,
    // only the environment variable name.
    harnessFiles.push({
      path: join(input.run_dir, "codex", "config.toml"),
      content: codexConfig(
        serverName,
        input.mcp.url,
        input.role.allowed_tools,
        coreFile,
        input.worker_launch && input.role.worktree === "none"
          ? []
          : [
              input.work_dir,
              ...(input.repository_root ? [input.repository_root] : []),
              ...(input.build_dir ? [input.build_dir] : []),
            ],
        browser,
      ),
      mode: 0o600,
    });
    harnessEnv.CODEX_HOME = join(sessionDir, "codex");
  },
  effortFromArgs(args) {
    let effort: string | undefined;
    const key = "model_reasoning_effort=";
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? "";
      if (arg === "--") break;
      let override: string | undefined;
      if (arg === "-c" || arg === "--config") {
        override = args[index + 1];
        index += 1;
      } else if (arg.startsWith("--config=")) override = arg.slice(9);
      else if (arg.startsWith("-c") && arg.length > 2) override = arg.slice(2);
      if (override === undefined) continue;
      const trimmed = override.trim();
      if (trimmed.startsWith(key))
        effort = codexValue(trimmed.slice(key.length).trim());
    }
    return effort;
  },
  profileArgs(profile) {
    return [
      ...Object.entries(profile.config ?? {}).flatMap(([key, value]) => [
        "-c",
        `${key}=${formatCodexConfigValue(value)}`,
      ]),
      ...(profile.args ?? []),
    ];
  },
};
