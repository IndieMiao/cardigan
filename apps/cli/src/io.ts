/** What the CLI needs from the outside world, with a fixed process exit code. */

export interface SpawnInheritOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
}

export interface CaptureOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
}

export interface CapturedOutput {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A started child process. `exit` resolves with the code Cardigan must return
 * (128 + signal number when the child was killed) and rejects when the spawn
 * itself failed, e.g. `ENOENT` for a missing CLI.
 */
export interface SpawnedChild {
  readonly pid: number | undefined;
  readonly exit: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}

/** The subset of `process` needed to install signal handlers. */
export interface SignalHost {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

/**
 * Everything the CLI needs from the outside world. Tests inject fake spawn and
 * signal functions so no real harness CLI is ever started.
 */
export interface CliIo {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly signals: SignalHost;
  stdout(text: string): void;
  stderr(text: string): void;
  spawnInherit(
    command: string,
    args: readonly string[],
    options: SpawnInheritOptions,
  ): SpawnedChild;
  captureCommand(
    command: string,
    args: readonly string[],
    options: CaptureOptions,
  ): Promise<CapturedOutput>;
}
