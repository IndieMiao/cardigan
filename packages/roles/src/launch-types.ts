import type { Harness } from "./harness.js";
import type { LaunchConfig } from "./schema-definition.js";
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
  /** Assignment publication stages this registry under run_dir/pi. */
  readonly piRegistryDir?: string;
  /** Arguments after `--`, passed through to the harness CLI. */
  readonly extraArgs?: readonly string[];
}
