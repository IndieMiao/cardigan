import { isAbsolute, join, resolve } from "node:path";
import { HARNESS_CATALOG } from "@cardigan/domain";
import { BROWSER_MCP_SERVER_NAME, TOKEN_ENV_VAR } from "../assignment-types.js";
import { LaunchConfigError } from "../errors.js";
import type { CompiledFile } from "../launch-types.js";
import { makePiContextUsageExtension } from "../pi-context-usage.js";
import {
  piInlineArgsConflict,
  piThinkingConfig,
  piThinkingLevels,
} from "../pi-model.js";
import { readPiContext } from "./pi-context.js";
import { onlyKey, validateSecretKey } from "./provider.js";
import type { HarnessAdapter } from "./types.js";
export const pi: HarnessAdapter = {
  ...HARNESS_CATALOG.pi,
  probeCredential(p) {
    return p.pi?.env_key ?? onlyKey(Object.keys(p.secret_env));
  },
  endpointEnvKey(p) {
    return p.base_url_env;
  },
  validateRoute(at, p, _name, details) {
    if (!p.base_url) return;
    if (!p.api) details.push(`${at}: Pi 内联端点需要 api`);
    validateSecretKey(at, "pi", p, p.pi?.env_key, false, details);
  },
  normalizeProfile({ profile, model }) {
    if (model) profile.provider_flag ??= model.provider;
    if (profile.effort)
      profile.args = ["--thinking", profile.effort, ...(profile.args ?? [])];
  },
  inlineProfile({ at, profile, model, provider, details }, configuredArgs) {
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
  },
  versionArgs: ["--version"],
  contextSource: "pi_turn_end:getContextUsage",
  readContext: readPiContext,
  compile({ input, resolved, providerEnv, secretEnv, profileArgs, extraArgs }) {
    const args: string[] = [];
    if (resolved.profile.provider_flag !== undefined) {
      args.push("--provider", resolved.profile.provider_flag);
    }
    if (resolved.profile.model !== undefined) {
      args.push("--model", resolved.profile.model);
    }
    args.push(...profileArgs, ...extraArgs);

    const env: Record<string, string> = { ...providerEnv, ...secretEnv };
    if (resolved.profile.agent_dir !== undefined) {
      env.PI_CODING_AGENT_DIR = resolved.profile.agent_dir;
    }

    const files: CompiledFile[] = [];
    const route = resolved.provider?.definition;
    if (
      route?.base_url &&
      resolved.profile.provider_flag &&
      resolved.profile.model
    ) {
      if (piInlineArgsConflict(extraArgs))
        throw new LaunchConfigError(
          "invalid_config",
          "Pi 内联模式不能用额外参数覆盖模型、接入点或推理强度",
        );
      const dir =
        input.piRegistryDir ??
        join(
          input.runtimeDir,
          `cardigan-${input.instanceId ?? "static"}.${resolved.name}.pi`,
        );
      const key = route.pi?.env_key ?? Object.keys(route.secret_env)[0];
      const meta = resolved.profile.pi_model;
      const registry = {
        providers: {
          [resolved.profile.provider_flag]: {
            baseUrl: route.base_url,
            api: route.api,
            apiKey: key ? `$${key}` : "cardigan-no-auth",
            models: [
              {
                id: resolved.profile.model,
                contextWindow: meta?.context_window,
                maxTokens: meta?.max_output_tokens,
                ...piThinkingConfig(
                  meta?.reasoning_efforts,
                  resolved.profile.effort,
                ),
              },
            ],
          },
        },
      };
      files.push({
        path: join(dir, "models.json"),
        content: `${JSON.stringify(registry)}\n`,
        mode: 0o600,
      });
      env.PI_CODING_AGENT_DIR = dir;
    }
    return {
      harness: "pi",
      profile: resolved.name,
      command: this.binary,
      args,
      env,
      files,
      secretEnvKeys: Object.keys(secretEnv),
    };
  },
  configureAssignment({
    input,
    base,
    sessionDir,
    coreFile,
    serverName,
    browser,
    harnessEnv,
    harnessArgs,
    harnessFiles,
  }) {
    const nativeHome = join(sessionDir, "pi");
    const localInlineHome =
      !input.worker_launch && base.files.length > 0
        ? base.env.PI_CODING_AGENT_DIR
        : undefined;
    const materialDir = localInlineHome ?? join(input.run_dir, "pi");
    if (localInlineHome && base.env.PI_CODING_AGENT_SESSION_DIR === undefined) {
      // Pi's default transcript location, independent of the disposable registry.
      const cwd = input.work_dir_real ?? input.work_dir;
      const key = `--${cwd.replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
      harnessEnv.PI_CODING_AGENT_SESSION_DIR = join(
        nativeHome,
        "sessions",
        key,
      );
    }
    // Keep mcp.json in the isolated PI_CODING_AGENT_DIR: putting it under
    // the worktree's .pi/ triggers project trust prompts that block unattended
    // terminals. Pi takes the prompt as a path (verified in 0.4 §3).
    harnessFiles.push({
      path: join(materialDir, "mcp.json"),
      content: `${JSON.stringify(
        {
          mcpServers: {
            [serverName]: {
              url: input.mcp.url,
              // Declare Card tools to the model without a codemode search.
              exposure: "direct",
              headers: { Authorization: `Bearer \${${TOKEN_ENV_VAR}}` },
            },
            ...(browser === undefined
              ? {}
              : {
                  [BROWSER_MCP_SERVER_NAME]: {
                    command: browser.command,
                    args: browser.args,
                    env: browser.env,
                    exposure: "direct",
                  },
                }),
          },
        },
        null,
        2,
      )}\n`,
      mode: 0o600,
    });
    harnessFiles.push({
      path: join(materialDir, "extensions", "cardigan-context-usage.js"),
      content: makePiContextUsageExtension(
        localInlineHome ? nativeHome : undefined,
      ),
      mode: 0o600,
    });
    // C-211: pre-trust exactly the folder pi starts in, the worktree the
    // host created for this Assignment, so a tracked .pi/settings.json does
    // not stop the unattended terminal at "Trust project folder?". The
    // saved decision lives in this run's own PI_CODING_AGENT_DIR (pi 1.4
    // `<agent-dir>/trust.json`, canonical path -> true): one exact path, no
    // parent folder, no pattern, and no change to `defaultProjectTrust`.
    // C-235: the key is the host-verified real path, because pi looks up
    // `realpath(cwd)`; no verified path means no pre-trust.
    if (
      input.work_dir_real !== undefined &&
      isAbsolute(input.work_dir_real) &&
      resolve(input.work_dir_real) === input.work_dir_real &&
      input.work_dir_real !== resolve(input.run_dir) &&
      resolve(input.work_dir) !== resolve(input.run_dir)
    )
      harnessFiles.push({
        path: join(materialDir, "trust.json"),
        content: `${JSON.stringify({ [input.work_dir_real]: true }, null, 2)}\n`,
        mode: 0o600,
      });
    harnessEnv.PI_CODING_AGENT_DIR = localInlineHome ?? nativeHome;
    harnessArgs.push("--append-system-prompt", coreFile);
  },
  effortFromArgs: () => undefined,
  activityDiagnostic: "会话活动可用；上游错误缺少结构化类别",
  registryDir(input) {
    return input.worker_launch
      ? join(input.run_dir, "pi")
      : join(
          input.run_dir,
          "pi",
          `launch-${encodeURIComponent(input.assignment.run_id)}`,
        );
  },
};
