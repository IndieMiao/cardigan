import { monitorEventLoopDelay } from "node:perf_hooks";

/**
 * C-628: event-loop delay of one process, for the host health page. The
 * off-site backfill hashes and uploads gigabytes; it must never starve the
 * MCP endpoint or the web server of the same host, so the delay of both the
 * syncing process and the process serving the page is shown, with an alert
 * above `LOOP_DELAY_LIMIT_MS`.
 */
export interface LoopDelay {
  readonly p99_ms: number;
  readonly max_ms: number;
  /** Length of the measured window. */
  readonly window_ms: number;
}

/** Health-page alert threshold for the 99th percentile. */
export const LOOP_DELAY_LIMIT_MS = 200;
const RESOLUTION_MS = 20;
const WINDOW_MS = 60_000;

const round = (ns: number) => Math.round(ns / 1e5) / 10;

export class LoopDelayMonitor {
  private readonly histogram = monitorEventLoopDelay({
    resolution: RESOLUTION_MS,
  });
  private started = performance.now();
  private previous: LoopDelay | undefined;
  private readonly timer: NodeJS.Timeout;

  constructor(windowMs = WINDOW_MS) {
    this.histogram.enable();
    this.timer = setInterval(() => this.roll(), windowMs);
    this.timer.unref();
  }

  private current(): LoopDelay | undefined {
    if (this.histogram.count === 0) return undefined;
    return {
      p99_ms: round(this.histogram.percentile(99)),
      max_ms: round(this.histogram.max),
      window_ms: Math.round(performance.now() - this.started),
    };
  }

  private roll() {
    this.previous = this.current() ?? this.previous;
    this.histogram.reset();
    this.started = performance.now();
  }

  /**
   * The worse of the last full window and the current one, so a spike stays
   * visible for at least one window after it ends.
   */
  snapshot(): LoopDelay | undefined {
    const now = this.current();
    const last = this.previous;
    if (!now || !last) return now ?? last;
    return {
      p99_ms: Math.max(now.p99_ms, last.p99_ms),
      max_ms: Math.max(now.max_ms, last.max_ms),
      window_ms: now.window_ms + last.window_ms,
    };
  }

  close() {
    clearInterval(this.timer);
    this.histogram.disable();
  }
}

let shared: LoopDelayMonitor | undefined;
/** One monitor per process, started on first use. */
export function processLoopDelay(): LoopDelayMonitor {
  shared ??= new LoopDelayMonitor();
  return shared;
}

export const loopDelaySlow = (delay: LoopDelay | undefined) =>
  delay !== undefined && delay.p99_ms > LOOP_DELAY_LIMIT_MS;
