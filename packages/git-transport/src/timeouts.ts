export interface GitTimeoutOptions {
  readonly queryTimeoutMs?: number;
  readonly transferTimeoutMs?: number;
}
export function gitTimeoutMs(
  command: string | undefined,
  options: GitTimeoutOptions,
): number {
  const transfer = ["clone", "fetch", "push", "bundle"].includes(command ?? "");
  const name = transfer
    ? "CARDIGAN_GIT_TRANSFER_TIMEOUT_MS"
    : "CARDIGAN_GIT_QUERY_TIMEOUT_MS";
  const option = transfer ? "transferTimeoutMs" : "queryTimeoutMs";
  const timeout =
    options[option] ??
    Number(process.env[name] ?? (transfer ? 1_800_000 : 30_000));
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647)
    throw new Error(
      `${name} (${option}) must be a positive integer no greater than 2147483647`,
    );
  return timeout;
}
/** Keep local queries bounded while allowing large packs to finish. */
export async function withGitTimeout<T>(
  command: string | undefined,
  options: GitTimeoutOptions,
  run: (timeoutMs: number) => Promise<T>,
): Promise<T> {
  const transfer = ["clone", "fetch", "push", "bundle"].includes(command ?? "");
  const name = transfer
    ? "CARDIGAN_GIT_TRANSFER_TIMEOUT_MS"
    : "CARDIGAN_GIT_QUERY_TIMEOUT_MS";
  const option = transfer ? "transferTimeoutMs" : "queryTimeoutMs";
  const timeout = gitTimeoutMs(command, options);
  try {
    return await run(timeout);
  } catch (error) {
    const e = error as {
      code?: string | number | null;
      killed?: boolean;
      signal?: string;
      executionExited?: boolean;
    };
    if (
      e.code === "runtime_timeout" ||
      (e.killed && e.signal === "SIGKILL" && e.code == null)
    )
      throw Object.assign(
        new Error(
          `Git ${command} timed out after ${timeout}ms; configure ${name} (${option})`,
          { cause: error },
        ),
        { executionExited: e.executionExited === true },
      );
    throw error;
  }
}
