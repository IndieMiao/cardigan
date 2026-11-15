export const GITHUB_POLL_DEFAULTS = {
  pollIntervalMs: 20_000,
  branchRetentionMs: 7 * 24 * 60 * 60_000,
  restBudgetPerHour: 2_000,
  waitStartMs: 15 * 60_000,
  failureExcerptBytes: 4 * 1024,
} as const;

export class GithubRetryLater extends Error {
  readonly category = "api" as const;
  constructor(readonly retryAt: number) {
    super("Check executor unavailable: api");
  }
}
export interface GithubBudgetState {
  window: number;
  used: number;
  blockedUntil: number;
}
export interface GithubBudgetStorage {
  /** Fresh atomic write transaction; a thrown operation must not commit. */
  update<T>(operation: (state: GithubBudgetState) => T): T;
}
/** One budget for every REST operation on an executor, including dispatch and logs. */
export class GithubRateLimit {
  private readonly memory: GithubBudgetState = {
    window: 0,
    used: 0,
    blockedUntil: 0,
  };
  constructor(
    private readonly budget = Number(GITHUB_POLL_DEFAULTS.restBudgetPerHour),
    private readonly now: () => number = Date.now,
    private readonly storage?: GithubBudgetStorage,
  ) {}
  private update<T>(operation: (state: GithubBudgetState) => T): T {
    return this.storage
      ? this.storage.update(operation)
      : operation(this.memory);
  }
  reserve(): () => void {
    const window = this.update((state) => {
      const now = this.now();
      if (now < state.blockedUntil)
        throw new GithubRetryLater(state.blockedUntil);
      if (now >= state.window + 3_600_000) {
        state.window = now;
        state.used = 0;
      }
      if (state.used >= this.budget)
        throw new GithubRetryLater(state.window + 3_600_000);
      state.used++;
      return state.window;
    });
    let refunded = false;
    return () => {
      if (refunded) return;
      this.update((state) => {
        if (state.window === window) state.used = Math.max(0, state.used - 1);
      });
      refunded = true;
    };
  }
  backoff(header: string | null): never {
    const seconds =
      header !== null && /^\d+$/u.test(header) ? Number(header) : NaN;
    const until = Number.isFinite(seconds)
      ? this.now() + seconds * 1000
      : Date.parse(header ?? "");
    const retryAt = this.update((state) => {
      state.blockedUntil = Math.max(
        state.blockedUntil,
        Number.isSafeInteger(until) && until > this.now()
          ? until
          : this.now() + GITHUB_POLL_DEFAULTS.pollIntervalMs,
      );
      return state.blockedUntil;
    });
    throw new GithubRetryLater(retryAt);
  }
}
