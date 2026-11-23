import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

/**
 * C-638: what this process is running right now — loop ticks and HTTP
 * requests, by name only (loop name, channel and route template; never a
 * path, query, body or card text). Always on, independent of the tick
 * profile switch: `StallWatch` names the activities that were running when
 * the event loop stalled, and lock timing is grouped by the current one.
 */
export type ActivityKind = "loop" | "request";

export interface Activity {
  readonly kind: ActivityKind;
  readonly name: string;
  readonly started: number;
  ended?: number;
}

const context = new AsyncLocalStorage<Activity>();
const running = new Set<Activity>();
/** Recently finished activities; a stall is detected only after it ends. */
const finished: Activity[] = [];
const FINISHED_KEPT = 64;

/** The activity owning the current async context, if any. */
export function currentActivity(): Activity | undefined {
  return context.getStore();
}

export interface ActivityHandle {
  /** Run `fn` with this activity as the current one. */
  run<T>(fn: () => T): T;
  /** Mark it finished; idempotent. */
  end(): void;
}

/** Start an activity whose end the caller signals (e.g. a response close). */
export function beginActivity(
  kind: ActivityKind,
  name: string,
): ActivityHandle {
  const activity: Activity = { kind, name, started: performance.now() };
  running.add(activity);
  return {
    run: (fn) => context.run(activity, fn),
    end: () => {
      if (activity.ended !== undefined) return;
      activity.ended = performance.now();
      running.delete(activity);
      finished.push(activity);
      if (finished.length > FINISHED_KEPT) finished.shift();
    },
  };
}

/** Run `fn` as an activity that ends when its promise settles. */
export async function trackActivity<T>(
  kind: ActivityKind,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  const handle = beginActivity(kind, name);
  try {
    return await handle.run(fn);
  } finally {
    handle.end();
  }
}

export interface ActivitySeen {
  readonly kind: ActivityKind;
  readonly name: string;
  readonly running_ms: number;
  /** Finished after `since`: it was the one blocking, or waited behind it. */
  readonly finished: boolean;
}

/**
 * Activities finished after `since`, then those still running at `at`;
 * longest first within each group, so a long-lived stream does not hide the
 * request that ended with the stall.
 */
export function activitiesSince(
  since: number,
  at = performance.now(),
): ActivitySeen[] {
  const seen = (a: Activity) => ({
    kind: a.kind,
    name: a.name,
    running_ms: Math.round((a.ended ?? at) - a.started),
    finished: a.ended !== undefined,
  });
  const longest = (a: ActivitySeen, b: ActivitySeen) =>
    b.running_ms - a.running_ms;
  return [
    ...finished
      .filter((a) => (a.ended ?? at) >= since)
      .map(seen)
      .sort(longest),
    ...[...running].map(seen).sort(longest),
  ];
}

export type StallLine = Readonly<Record<string, unknown>>;

export interface StallWatchOptions {
  readonly log: (line: StallLine) => void;
  /** Release commit stamped on every line, as on the tick profile lines. */
  readonly sha?: string;
  readonly now?: () => Date;
  /** A timer late by at least this much is a stall; default 2 s. */
  readonly thresholdMs?: number;
  /** Timer cadence; default 500 ms. */
  readonly intervalMs?: number;
}

/** Longest list of activities per stall line. */
const STALL_ACTIVITIES = 20;

/**
 * C-638: a timer that should fire every `intervalMs`. When it fires
 * `thresholdMs` or more late, the event loop was blocked; one
 * `event_loop_stall` line names the loops and requests running during the
 * block (still running, or finished after it began).
 */
export class StallWatch {
  readonly #log: (line: StallLine) => void;
  readonly #threshold: number;
  readonly #interval: number;
  #last = performance.now();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: StallWatchOptions) {
    const sha = options.sha ?? "unknown";
    const now = options.now ?? (() => new Date());
    this.#log = (line) =>
      options.log({ ...line, ts: now().toISOString(), sha });
    this.#threshold = options.thresholdMs ?? 2000;
    this.#interval = options.intervalMs ?? 500;
    this.#timer = setInterval(() => this.check(), this.#interval);
    this.#timer.unref();
  }

  /** Compare the elapsed time with the cadence; exposed for tests. */
  check(at = performance.now()): void {
    const delay = at - this.#last - this.#interval;
    this.#last = at;
    if (delay < this.#threshold) return;
    const during = activitiesSince(at - delay, at);
    const pick = (kind: ActivityKind) => {
      const all = during.filter((a) => a.kind === kind);
      return {
        list: all
          .slice(0, STALL_ACTIVITIES)
          .map(({ name, running_ms, finished }) => ({
            name,
            running_ms,
            ...(finished ? { finished } : {}),
          })),
        more: Math.max(0, all.length - STALL_ACTIVITIES),
      };
    };
    const loops = pick("loop");
    const requests = pick("request");
    this.#log({
      event: "event_loop_stall",
      delay_ms: Math.round(delay),
      loops: loops.list,
      requests: requests.list,
      ...(loops.more ? { more_loops: loops.more } : {}),
      ...(requests.more ? { more_requests: requests.more } : {}),
    });
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
