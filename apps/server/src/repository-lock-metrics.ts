import type { RepositoryLockSample } from "@cardigan/git-service";

/**
 * C-636: always-on wait and hold times of the project repository lock, per
 * project, machine and operation. Each report interval logs one
 * `repository_lock` line per group that was used, then starts a new window;
 * a wait that timed out is also logged at once. Lines carry ids, operation
 * names and numbers only — never paths, refs, SHAs or tokens.
 */
export interface RepositoryLockMetricsOptions {
  readonly log: (line: Readonly<Record<string, unknown>>) => void;
  /** Release commit stamped on every line. */
  readonly sha?: string;
  readonly now?: () => Date;
  /** Window length; 0 disables the timer (tests call `report`). */
  readonly reportIntervalMs?: number;
  /** Samples kept per group and window for percentiles; counts stay exact. */
  readonly maxSamples?: number;
}

interface Window {
  n: number;
  timeouts: number;
  errors: number;
  waitMaxMs: number;
  holdMaxMs: number;
  readonly wait: number[];
  readonly hold: number[];
}

export const DEFAULT_LOCK_REPORT_INTERVAL_MS = 10 * 60_000;
const DEFAULT_MAX_SAMPLES = 4096;

const round = (n: number) => Math.round(n * 10) / 10;

function percentiles(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    round(
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0,
    );
  return { p50: at(0.5), p95: at(0.95) };
}

export class RepositoryLockMetrics {
  readonly #log: RepositoryLockMetricsOptions["log"];
  readonly #maxSamples: number;
  readonly #windows = new Map<string, Window>();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: RepositoryLockMetricsOptions) {
    const sha = options.sha ?? "unknown";
    const now = options.now ?? (() => new Date());
    this.#log = (line) =>
      options.log({ ...line, ts: now().toISOString(), sha });
    this.#maxSamples = options.maxSamples ?? DEFAULT_MAX_SAMPLES;
    const interval =
      options.reportIntervalMs ?? DEFAULT_LOCK_REPORT_INTERVAL_MS;
    if (interval > 0) {
      this.#timer = setInterval(() => this.report(), interval);
      this.#timer.unref();
    }
  }

  /** The lock's `observe` hook. */
  readonly record = (sample: RepositoryLockSample): void => {
    const key = JSON.stringify([
      sample.project_id,
      sample.machine_id,
      sample.operation,
    ]);
    let window = this.#windows.get(key);
    if (!window) {
      window = {
        n: 0,
        timeouts: 0,
        errors: 0,
        waitMaxMs: 0,
        holdMaxMs: 0,
        wait: [],
        hold: [],
      };
      this.#windows.set(key, window);
    }
    window.n++;
    if (sample.outcome === "timeout") window.timeouts++;
    if (sample.outcome === "error") window.errors++;
    window.waitMaxMs = Math.max(window.waitMaxMs, sample.wait_ms);
    if (window.wait.length < this.#maxSamples) window.wait.push(sample.wait_ms);
    if (sample.outcome !== "timeout") {
      window.holdMaxMs = Math.max(window.holdMaxMs, sample.hold_ms);
      if (window.hold.length < this.#maxSamples)
        window.hold.push(sample.hold_ms);
    }
    if (sample.outcome === "timeout")
      this.#log({
        event: "repository_lock_timeout",
        project_id: sample.project_id,
        machine_id: sample.machine_id,
        operation: sample.operation,
        wait_ms: round(sample.wait_ms),
      });
  };

  /** Log and reset the current window. */
  report(): void {
    const windows = [...this.#windows];
    this.#windows.clear();
    for (const [key, w] of windows) {
      const [project_id, machine_id, operation] = JSON.parse(key) as string[];
      const wait = percentiles(w.wait);
      const hold = percentiles(w.hold);
      this.#log({
        event: "repository_lock",
        project_id,
        machine_id,
        operation,
        n: w.n,
        timeouts: w.timeouts,
        errors: w.errors,
        wait_p50_ms: wait.p50,
        wait_p95_ms: wait.p95,
        wait_max_ms: round(w.waitMaxMs),
        hold_p50_ms: hold.p50,
        hold_p95_ms: hold.p95,
        hold_max_ms: round(w.holdMaxMs),
      });
    }
  }

  /** Flush the last window and stop the timer. */
  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.report();
  }
}
