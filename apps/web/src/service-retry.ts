/**
 * C-250: riding out a short server outage (an automatic deploy restarts the
 * server for ~11 seconds; the proxy answers 502/503 or refuses the connection).
 *
 * Only reads and writes that carry an idempotency key are retried, always with
 * the same request (and so the same key), so a write takes effect at most once.
 */

/**
 * Waits before each automatic retry, in milliseconds; its length is the number
 * of retries after the first attempt.
 *
 * 已定，依据 Q-415（数值规则，由人拍板）：重试 4 次，间隔 1、2、4、8 秒，
 * 累计约 15 秒，覆盖一次自动部署约 11 秒的停服。
 */
export const SERVICE_RETRY_DELAYS_MS: readonly number[] = [
  1_000, 2_000, 4_000, 8_000,
];

/** HTTP statuses that mean "the server is restarting", not "the request failed". */
export const SERVICE_UPDATING_STATUSES: ReadonlySet<number> = new Set([
  502, 503,
]);

/** Shown while a request waits for the server to come back. */
export const SERVICE_UPDATING_MESSAGE = "服务正在更新，几秒后自动重试…";

/**
 * C-775: the read pool's 503 codes for "too busy to read right now"
 * (`read_timeout` after its ~30 s budget, `read_busy` when its queue is full).
 * They are an overload, not a restart: retrying them as fast as a restart
 * only adds load, so they follow {@link READ_OVERLOAD_RETRY_DELAYS_MS} and do
 * not raise the "服务正在更新" notice.
 */
export const READ_OVERLOAD_CODES: ReadonlySet<string> = new Set([
  "read_timeout",
  "read_busy",
]);

/**
 * C-775: waits before each automatic retry of a read the server refused as
 * overloaded; its length is the retry limit. Default chosen by the author
 * (C-775): 2 retries, 5 then 15 seconds. A `read_timeout` attempt itself
 * takes ~30 s, so a page gives up after about two minutes at most and then
 * shows the failure with a retry button.
 */
export const READ_OVERLOAD_RETRY_DELAYS_MS: readonly number[] = [5_000, 15_000];

/** True for an error the read pool raised because it was overloaded. */
export function isReadOverload(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return (
    status === 503 && typeof code === "string" && READ_OVERLOAD_CODES.has(code)
  );
}

export function isRetryableRequest(
  method: string,
  idempotencyKey: string | undefined,
): boolean {
  return method === "GET" || method === "HEAD" || idempotencyKey !== undefined;
}

/** How many requests are currently waiting out an outage; drives the notice. */
export class ServiceUpdatingNotice {
  private waiting = 0;
  private readonly listeners = new Set<() => void>();

  /** Marks one request as retrying; call the returned function once it settles. */
  begin(): () => void {
    let ended = false;
    this.waiting++;
    this.emit();
    return () => {
      if (ended) return;
      ended = true;
      this.waiting--;
      this.emit();
    };
  }

  readonly active = (): boolean => this.waiting > 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

/** The notice the production client reports to and the App shell renders. */
export const serviceUpdatingNotice = new ServiceUpdatingNotice();

export interface RetryPolicy {
  readonly delaysMs: readonly number[];
  /** C-775: backoff for reads refused as overloaded (see READ_OVERLOAD_CODES). */
  readonly readOverloadDelaysMs: readonly number[];
  readonly sleep: (ms: number) => Promise<void>;
  readonly notice: ServiceUpdatingNotice;
}

export const defaultRetryPolicy: RetryPolicy = {
  delaysMs: SERVICE_RETRY_DELAYS_MS,
  readOverloadDelaysMs: READ_OVERLOAD_RETRY_DELAYS_MS,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  notice: serviceUpdatingNotice,
};
