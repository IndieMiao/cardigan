import { join } from "node:path";
import { LaunchConfigError } from "./errors.js";
import { HARNESS_BINARY, type Harness } from "./harness.js";
import { type LaunchConfig, resolveProfile } from "./schema.js";

/** A file Cardigan must create before starting the CLI, and remove afterwards. */
export interface CompiledFile {
  readonly path: string;
  readonly content: string;
  /** POSIX permission bits, e.g. 0o600. */
  readonly mode: number;
}

export interface CompiledLaunch {
  readonly harness: Harness;
  readonly profile: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Environment for the child process, secrets included. */
  readonly env: Readonly<Record<string, string>>;
  readonly files: readonly CompiledFile[];
  /** Environment variable names whose value came from `secrets.env`. */
  readonly secretEnvKeys: readonly string[];
}

export interface CompileLaunchInput {
  readonly config: LaunchConfig;
  readonly profile: string;
  /** Values read from `secrets.env`, keyed by secret name. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Directory for temporary files; the caller decides the location. */
  readonly runtimeDir: string;
  /**
   * Unique per launch, embedded in generated file names so two concurrent
   * launches never share a file. The CLI passes `<pid>-<random hex>`; tests
   * pass a fixed value. Defaults to `static` for callers that only inspect the
   * compiled output (e.g. a dry run).
   */
  readonly instanceId?: string;
  /** Arguments after `--`, passed through to the harness CLI. */
  readonly extraArgs?: readonly string[];
}

/**
 * Turn a launch profile into the exact command, arguments, environment and
 * temporary files needed to start a harness CLI.
 *
 * Pure: no filesystem access, no process spawning, no clock. The CLI layer
 * writes `files`, spawns `command`, and removes the files afterwards.
 */
export function compileLaunch(input: CompileLaunchInput): CompiledLaunch {
  const resolved = resolveProfile(input.config, input.profile);
  const providerEnv = resolved.provider?.definition.env ?? {};
  const secretEnv: Record<string, string> = {};
  const missing: string[] = [];

  for (const [envName, secretKey] of Object.entries(
    resolved.provider?.definition.secret_env ?? {},
  )) {
    const value = input.secrets[secretKey];
    if (value === undefined || value.length === 0) {
      missing.push(
        `secrets.env 里缺少 ${secretKey}（接入点 ${resolved.provider?.name}）`,
      );
      continue;
    }
    secretEnv[envName] = value;
  }

  if (missing.length > 0) {
    throw new LaunchConfigError(
      "missing_secret",
      `启动配置 ${resolved.name} 需要的密钥不齐`,
      missing,
    );
  }

  const extraArgs = input.extraArgs ?? [];
  const profileArgs = resolved.profile.args ?? [];

  switch (resolved.profile.harness) {
    case "claude-code":
      return compileClaudeCode();
    case "codex":
      return compileCodex();
    case "pi":
      return compilePi();
  }

  function compileClaudeCode(): CompiledLaunch {
    // Claude Code reads provider settings from a settings file. Cardigan writes
    // that file outside the repository, with 0600, and deletes it after exit.
    // Provider env (including resolved secrets) lives in the file, not in the
    // process environment, so the gateway token is not visible in `ps e`.
    // `<pid>-<random>` in the name keeps concurrent launches apart, and lets
    // the next launch find files left behind by a process that no longer runs.
    const settingsPath = join(
      input.runtimeDir,
      `cardigan-${input.instanceId ?? "static"}.${resolved.name}.claude-settings.json`,
    );
    const settings = {
      env: { ...providerEnv, ...secretEnv },
    };

    const args: string[] = ["--settings", settingsPath];
    if (resolved.profile.model !== undefined) {
      args.push("--model", resolved.profile.model);
    }
    if (resolved.profile.permission_mode !== undefined) {
      args.push("--permission-mode", resolved.profile.permission_mode);
    }
    args.push(...profileArgs, ...extraArgs);

    const env: Record<string, string> = {};
    if (resolved.profile.auto_update === false) {
      env.DISABLE_AUTOUPDATER = "1";
    }

    return {
      harness: "claude-code",
      profile: resolved.name,
      command: HARNESS_BINARY["claude-code"],
      args,
      env,
      files: [
        {
          path: settingsPath,
          content: `${JSON.stringify(settings, null, 2)}\n`,
          mode: 0o600,
        },
      ],
      secretEnvKeys: Object.keys(secretEnv),
    };
  }

  function compileCodex(): CompiledLaunch {
    // Codex keeps its own config; Cardigan only composes arguments:
    // `--profile`, `-c key=value` overrides, `-m`, then extra arguments.
    const args: string[] = [];
    if (resolved.provider !== undefined) {
      args.push("--profile", resolved.provider.name);
    }
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
      command: HARNESS_BINARY.codex,
      args,
      env: { ...providerEnv, ...secretEnv },
      files: [],
      secretEnvKeys: Object.keys(secretEnv),
    };
  }

  function compilePi(): CompiledLaunch {
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

    return {
      harness: "pi",
      profile: resolved.name,
      command: HARNESS_BINARY.pi,
      args,
      env,
      files: [],
      secretEnvKeys: Object.keys(secretEnv),
    };
  }
}

/** Codex `-c` values: strings are quoted, numbers and booleans stay literal. */
export function formatCodexConfigValue(
  value: string | number | boolean,
): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
