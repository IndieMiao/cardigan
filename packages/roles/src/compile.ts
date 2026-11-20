import { getHarnessAdapter } from "./adapters/registry.js";
import { LaunchConfigError } from "./errors.js";
import type { CompiledLaunch, CompileLaunchInput } from "./launch-types.js";
import { type ResolvedProfile, resolveProfile } from "./schema.js";

export type {
  CompiledFile,
  CompiledLaunch,
  CompileLaunchInput,
} from "./launch-types.js";
/**
 * Turn a launch profile into the exact command, arguments, environment and
 * temporary files needed to start a harness CLI.
 *
 * Pure: no filesystem access, no process spawning, no clock. The CLI layer
 * writes `files`, spawns `command`, and removes the files afterwards.
 */
export function compileLaunch(input: CompileLaunchInput): CompiledLaunch {
  return compileResolvedLaunch(
    input,
    resolveProfile(input.config, input.profile),
  );
}
/** Assignment compilation has already resolved the profile to select its adapter. */
export function compileResolvedLaunch(
  input: CompileLaunchInput,
  resolved: ResolvedProfile,
): CompiledLaunch {
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

  return getHarnessAdapter(resolved.profile.harness).compile({
    input,
    resolved,
    providerEnv,
    secretEnv,
    profileArgs: resolved.profile.args ?? [],
    extraArgs: input.extraArgs ?? [],
  });
}
