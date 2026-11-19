import { homedir } from "node:os";
import { join } from "node:path";
import { resolveDataDirectory } from "@cardigan/runtime-herdr";
import type { CliIo } from "./io.js";

export interface LaunchPaths {
  readonly dataDir: string;
  /** Directory holding `launch.yaml` and `secrets.env`. */
  readonly configDir: string;
  readonly launchFile: string;
  readonly secretsFile: string;
  /** Directory for generated temporary harness files. */
  readonly runtimeDir: string;
}

export interface PathEnv {
  readonly CARDIGAN_DATA_DIR?: string | undefined;
  readonly HOME?: string | undefined;
  readonly CARDIGAN_CONFIG_DIR?: string | undefined;
  readonly XDG_RUNTIME_DIR?: string | undefined;
}

/**
 * Resolve where launch configuration and temporary files live.
 *
 * `CARDIGAN_CONFIG_DIR` overrides the config directory; tests use it so they
 * never touch a real `~/.config/cardigan`. Generated harness files go to
 * `$XDG_RUNTIME_DIR/cardigan/` when the variable is set, otherwise to
 * `~/.cache/cardigan/run/`.
 */
export function resolveLaunchPaths(
  env: PathEnv,
  home: string = homedir(),
  cwd: string = process.cwd(),
): LaunchPaths {
  const configDir =
    env.CARDIGAN_CONFIG_DIR !== undefined && env.CARDIGAN_CONFIG_DIR.length > 0
      ? env.CARDIGAN_CONFIG_DIR
      : join(home, ".config", "cardigan");
  const runtimeRoot =
    env.XDG_RUNTIME_DIR !== undefined && env.XDG_RUNTIME_DIR.length > 0
      ? join(env.XDG_RUNTIME_DIR, "cardigan")
      : join(home, ".cache", "cardigan", "run");

  return {
    dataDir: resolveDataDirectory({ ...env, HOME: env.HOME ?? home }, cwd),
    configDir,
    launchFile: join(configDir, "launch.yaml"),
    secretsFile: join(configDir, "secrets.env"),
    runtimeDir: runtimeRoot,
  };
}

/** Carry the invoking command's store location through to the catalog cache. */
export function cliLaunchPaths(io: CliIo, override?: string): LaunchPaths {
  const env = {
    ...io.env,
    CARDIGAN_DATA_DIR: override ?? io.env.CARDIGAN_DATA_DIR,
  };
  return resolveLaunchPaths(env, undefined, io.cwd);
}
