import { getHarnessAdapter } from "./adapters/registry.js";
import type { Harness } from "./harness.js";
import type { LaunchProfileDefinition } from "./schema.js";

/**
 * C-106: the launch settings a Run snapshots beside its model, for the
 * execution view. `effort` is only present when the launch arguments state
 * it unambiguously; anything else (Pi, a codex profile that leaves it to its
 * own config.toml, an override we cannot read) is unknown, never guessed.
 */
export interface LaunchSettings {
  readonly harness: Harness;
  readonly effort?: string;
}

/**
 * The effort the harness CLI actually receives from these arguments: the last
 * occurrence before `--` wins, as the CLIs parse them. A flag whose value cannot be read
 * makes the effort unknown rather than falling back to an earlier one.
 */
export function effortFromArgs(
  harness: Harness,
  args: readonly string[],
): string | undefined {
  return getHarnessAdapter(harness).effortFromArgs(args);
}
/** Settings for compiled launch arguments (what the session was started with). */
export function compiledLaunchSettings(
  harness: Harness,
  args: readonly string[],
): LaunchSettings {
  const effort = effortFromArgs(harness, args);
  return effort === undefined ? { harness } : { harness, effort };
}

/**
 * Settings for a profile before it is compiled: the same argument order the
 * compiler produces (codex `config` overrides, then the profile's args).
 */
export function profileLaunchSettings(
  profile: LaunchProfileDefinition,
): LaunchSettings {
  const args =
    getHarnessAdapter(profile.harness).profileArgs?.(profile) ??
    profile.args ??
    [];
  return compiledLaunchSettings(profile.harness, args);
}
