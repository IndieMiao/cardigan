/**
 * Login backoff (M5 plan §3.2: 暴力破解).
 *
 * Failures are counted per source. After `MAX_LOGIN_FAILURES` consecutive
 * failures the source is locked out for an exponentially growing window, so a
 * password guess turns from "one HTTP request each" into "hours per handful".
 * The counter resets on a successful login and is entirely in memory: a restart
 * clears it, which is acceptable for a single-user loopback listener.
 */

export const MAX_LOGIN_FAILURES = 5;
export const LOGIN_LOCKOUT_MS = 30_000;
export const MAX_LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

interface Entry {
  failures: number;
  blockedUntil: number;
}

export class LoginLimiter {
  readonly #entries = new Map<string, Entry>();

  /** Seconds the source must wait, or `undefined` when it may try now. */
  retryAfterSeconds(key: string, now: number = Date.now()): number | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined || entry.blockedUntil <= now) {
      return undefined;
    }
    return Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000));
  }

  /** Count one failed attempt and return the lockout window it triggered. */
  recordFailure(key: string, now: number = Date.now()): number {
    const entry = this.#entries.get(key) ?? { failures: 0, blockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= MAX_LOGIN_FAILURES) {
      const over = entry.failures - MAX_LOGIN_FAILURES;
      const window = Math.min(
        LOGIN_LOCKOUT_MS * 2 ** over,
        MAX_LOGIN_LOCKOUT_MS,
      );
      entry.blockedUntil = now + window;
    }
    this.#entries.set(key, entry);
    return Math.max(0, entry.blockedUntil - now);
  }

  recordSuccess(key: string): void {
    this.#entries.delete(key);
  }

  /** Number of consecutive failures recorded for a source (tests). */
  failures(key: string): number {
    return this.#entries.get(key)?.failures ?? 0;
  }

  reset(): void {
    this.#entries.clear();
  }
}
