import { setTimeout as delay } from "node:timers/promises";

/** C-650: total time a background start keeps waiting for a write lock. */
export const DEFAULT_STARTUP_BUSY_WAIT_MS = 60_000;
/** C-650: pause between two start attempts. */
export const DEFAULT_STARTUP_BUSY_RETRY_MS = 2_000;

export interface StartupBusyRetryOptions {
  readonly waitMs: number;
  readonly retryMs: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** One line per retry; the deployment log maps it to a fixed cause label. */
  readonly warn?: (line: string) => void;
}

/** SQLITE_BUSY (5) or SQLITE_LOCKED (6), anywhere in the cause chain. */
export function isDatabaseLocked(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 8; depth++) {
    if (typeof e !== "object") return false;
    const code = (e as { errcode?: unknown }).errcode;
    if (typeof code === "number" && [5, 6].includes(code & 0xff)) return true;
    const message = (e as { message?: unknown }).message;
    if (
      typeof message === "string" &&
      /\bdatabase (?:table )?is locked\b/u.test(message)
    )
      return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Read the host's optional overrides; an invalid value stops the start. */
export function startupBusyRetryConfig(env: NodeJS.ProcessEnv): {
  waitMs: number;
  retryMs: number;
} {
  const read = (name: string, fallback: number, min: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > 2147483647)
      throw new Error(`${name} 必须是 ${min} 以上的整数毫秒`);
    return value;
  };
  return {
    waitMs: read(
      "CARDIGAN_STARTUP_BUSY_WAIT_MS",
      DEFAULT_STARTUP_BUSY_WAIT_MS,
      0,
    ),
    retryMs: read(
      "CARDIGAN_STARTUP_BUSY_RETRY_MS",
      DEFAULT_STARTUP_BUSY_RETRY_MS,
      1,
    ),
  };
}

/**
 * C-650: a deployment starts the new background process right after the old
 * one stopped; another connection may still hold the SQLite write lock for a
 * moment. Retry a start that failed only because the database was locked,
 * within a bounded wait, instead of exiting and rolling the deployment back.
 * Every failed attempt has already released its store and locks.
 */
export async function startWithBusyRetry<T>(
  start: () => Promise<T>,
  options: StartupBusyRetryOptions,
): Promise<T> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const deadline = now() + options.waitMs;
  for (let attempt = 1; ; attempt++) {
    try {
      return await start();
    } catch (error) {
      const remaining = deadline - now();
      if (!isDatabaseLocked(error) || remaining <= 0) throw error;
      const pause = Math.min(options.retryMs, remaining);
      options.warn?.(
        `startup_database_locked: database is locked; retry ${attempt} in ${pause} ms`,
      );
      await sleep(pause);
    }
  }
}
