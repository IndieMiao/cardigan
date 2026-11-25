import { AsyncLocalStorage } from "node:async_hooks";

// Bound only transfers started by merge maintenance. User clones, backups,
// and other tasks keep their configured budget, even in the same process.
const mergeTransfer = new AsyncLocalStorage<true>();
export function withMergeTransferBudget<T>(work: () => T): T {
  return mergeTransfer.run(true, work);
}
/** Bulk object work; C-637: maintenance repacks write whole packs too. */
const longCommands = ["clone", "fetch", "push", "bundle", "repack"];
export interface GitTimeoutOptions {
  readonly queryTimeoutMs?: number;
  readonly transferTimeoutMs?: number;
}
export function gitTimeoutMs(
  command: string | undefined,
  options: GitTimeoutOptions,
): number {
  const transfer = longCommands.includes(command ?? "");
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
  if (!transfer || !mergeTransfer.getStore()) return timeout;
  const cap = Number(
    process.env.CARDIGAN_MERGE_GIT_TRANSFER_TIMEOUT_MS ?? 180_000,
  );
  if (!Number.isSafeInteger(cap) || cap <= 0 || cap > 2_147_483_647)
    throw new Error(
      "CARDIGAN_MERGE_GIT_TRANSFER_TIMEOUT_MS must be a positive integer no greater than 2147483647",
    );
  return Math.min(timeout, cap);
}
/** Keep local queries bounded while allowing large packs to finish. */
export async function withGitTimeout<T>(
  command: string | undefined,
  options: GitTimeoutOptions,
  run: (timeoutMs: number) => Promise<T>,
): Promise<T> {
  const transfer = longCommands.includes(command ?? "");
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
          `Git ${command} timed out after ${timeout}ms; configure ${name} (${option})${transfer && mergeTransfer.getStore() ? " / CARDIGAN_MERGE_GIT_TRANSFER_TIMEOUT_MS" : ""}`,
          { cause: error },
        ),
        { executionExited: e.executionExited === true },
      );
    throw error;
  }
}
