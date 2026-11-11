import { formatCodexConfigValue } from "./compile.js";
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

const EFFORT = /^[A-Za-z0-9_-]{1,32}$/u;
const plain = (value: string | undefined) =>
  value !== undefined && EFFORT.test(value) ? value : undefined;

/** Codex `-c` values are TOML; a bare word is taken as a string. */
function codexValue(raw: string): string | undefined {
  const quoted = /^"([^"\\]*)"$|^'([^']*)'$/u.exec(raw);
  return plain(quoted ? (quoted[1] ?? quoted[2]) : raw);
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
  let effort: string | undefined;
  if (harness === "claude-code") {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? "";
      if (arg === "--") break;
      if (arg === "--effort") {
        effort = plain(args[index + 1]);
        index += 1;
      } else if (arg.startsWith("--effort="))
        effort = plain(arg.slice("--effort=".length));
    }
    return effort;
  }
  if (harness === "codex") {
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
  }
  return undefined;
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
    profile.harness === "codex"
      ? [
          ...Object.entries(profile.config ?? {}).flatMap(([key, value]) => [
            "-c",
            `${key}=${formatCodexConfigValue(value)}`,
          ]),
          ...(profile.args ?? []),
        ]
      : (profile.args ?? []);
  return compiledLaunchSettings(profile.harness, args);
}
