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
 * Everything the CLI needs from the outside world. Tests inject a fake spawn
 * function so no real harness CLI is ever started.
 */
export interface CliIo {
  readonly env: Record<string, string | undefined>;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  stdout(text: string): void;
  stderr(text: string): void;
  spawnInherit(
    command: string,
    args: readonly string[],
    options: SpawnInheritOptions,
  ): Promise<number>;
  captureCommand(
    command: string,
    args: readonly string[],
    options: CaptureOptions,
  ): Promise<CapturedOutput>;
}
