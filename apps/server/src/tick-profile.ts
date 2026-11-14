import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { StoreObserver } from "@cardigan/store";

/**
 * C-216: opt-in measurement of the periodic loops (dispatcher, merge, cleanup,
 * reconcile, backup, ...). Off by default; when off every hook is a plain
 * pass-through. Output carries loop names, span names and numbers only — never
 * SQL, card text, prompts, tokens or request bodies. C-265: every line also
 * carries `ts` (ISO time) and `sha` (the running release commit, or
 * "unknown"), so a window can be cut by time and version.
 */
export type ProfileLine = Readonly<Record<string, unknown>>;

interface TickSample {
  uowMs: number;
  uowCount: number;
  uowMaxMs: number;
  stateMs: number;
  stateCount: number;
  readonly spans: Map<string, number>;
}

interface Latencies {
  busy: number[];
  idle: number[];
}

const round = (n: number) => Math.round(n * 10) / 10;
const nsToMs = (n: number) => round(n / 1e6);

function summary(values: readonly number[]) {
  if (!values.length) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    round(
      sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0,
    );
  return {
    n: sorted.length,
    p50_ms: at(0.5),
    p95_ms: at(0.95),
    max_ms: round(sorted[sorted.length - 1] ?? 0),
  };
}

export interface TickProfilerOptions {
  readonly log: (line: ProfileLine) => void;
  /** C-265: release commit stamped on every line; see `releaseSha`. */
  readonly sha?: string;
  /** Wall clock for `ts`; tests inject it. */
  readonly now?: () => Date;
  /** Cadence of the event-loop and request summaries; 0 disables the timer. */
  readonly reportIntervalMs?: number;
  /** Event-loop delay sampling resolution. */
  readonly resolutionMs?: number;
}

export class TickProfiler {
  readonly #als = new AsyncLocalStorage<TickSample>();
  readonly #log: (line: ProfileLine) => void;
  readonly #resolution: number;
  readonly #window: ReturnType<typeof monitorEventLoopDelay>;
  #timer: ReturnType<typeof setInterval> | undefined;
  #active = new Map<string, number>();
  #lastTickEnd = Number.NEGATIVE_INFINITY;
  #requests = new Map<string, Latencies>();

  constructor(options: TickProfilerOptions) {
    const sha = options.sha ?? "unknown";
    const now = options.now ?? (() => new Date());
    this.#log = (line) =>
      options.log({ ...line, ts: now().toISOString(), sha });
    this.#resolution = options.resolutionMs ?? 10;
    this.#window = monitorEventLoopDelay({ resolution: this.#resolution });
    this.#window.enable();
    const interval = options.reportIntervalMs ?? 60_000;
    if (interval > 0) {
      this.#timer = setInterval(() => this.report(), interval);
      this.#timer.unref();
    }
  }

  /** Hooks for `Store.observe`; attributes UnitOfWork time to the running tick. */
  readonly storeObserver: StoreObserver = {
    transaction: (_kind, ms) => {
      const sample = this.#als.getStore();
      if (!sample) return;
      sample.uowMs += ms;
      sample.uowCount++;
      if (ms > sample.uowMaxMs) sample.uowMaxMs = ms;
    },
    stateBuild: (ms) => {
      const sample = this.#als.getStore();
      if (!sample) return;
      sample.stateMs += ms;
      sample.stateCount++;
    },
  };

  /** Loops whose tick is running right now. */
  activeLoops(): string[] {
    return [...this.#active].filter(([, n]) => n > 0).map(([name]) => name);
  }

  async tick<T>(loop: string, run: () => Promise<T>): Promise<T> {
    const sample: TickSample = {
      uowMs: 0,
      uowCount: 0,
      uowMaxMs: 0,
      stateMs: 0,
      stateCount: 0,
      spans: new Map(),
    };
    // Event-loop utilization over the tick: 1.0 means the loop never got to
    // serve a timer or socket while this tick ran (it may include other
    // loops' synchronous work that overlapped).
    const elu = performance.eventLoopUtilization();
    this.#active.set(loop, (this.#active.get(loop) ?? 0) + 1);
    const started = performance.now();
    try {
      return await this.#als.run(sample, run);
    } finally {
      const wall = performance.now() - started;
      this.#active.set(loop, (this.#active.get(loop) ?? 1) - 1);
      this.#lastTickEnd = performance.now();
      this.#log({
        event: "tick_profile",
        loop,
        wall_ms: round(wall),
        uow_ms: round(sample.uowMs),
        uow_count: sample.uowCount,
        uow_max_ms: round(sample.uowMaxMs),
        state_build_ms: round(sample.stateMs),
        state_builds: sample.stateCount,
        // Wall time outside UnitOfWork: awaited IO (Git/subprocess, runtime,
        // files, timers) plus unattributed synchronous code between them.
        outside_uow_ms: round(Math.max(0, wall - sample.uowMs)),
        event_loop_utilization:
          Math.round(performance.eventLoopUtilization(elu).utilization * 100) /
          100,
        ...(sample.spans.size
          ? {
              spans: Object.fromEntries(
                [...sample.spans].map(([k, v]) => [k, round(v)]),
              ),
            }
          : {}),
      });
    }
  }

  /** Time a named phase of the current tick; nested names are not supported. */
  async span<T>(name: string, run: () => Promise<T> | T): Promise<T> {
    const sample = this.#als.getStore();
    const started = performance.now();
    try {
      return await run();
    } finally {
      if (sample)
        sample.spans.set(
          name,
          (sample.spans.get(name) ?? 0) + performance.now() - started,
        );
    }
  }

  /** Synchronous `span`: adds no await, so callers keep their interleaving. */
  spanSync<T>(name: string, run: () => T): T {
    const sample = this.#als.getStore();
    const started = performance.now();
    try {
      return run();
    } finally {
      if (sample)
        sample.spans.set(
          name,
          (sample.spans.get(name) ?? 0) + performance.now() - started,
        );
    }
  }

  /** A finished HTTP request; `busy` when its lifetime overlapped any tick. */
  request(channel: string, durationMs: number): void {
    if (!Number.isFinite(durationMs)) return;
    const busy =
      this.activeLoops().length > 0 ||
      this.#lastTickEnd >= performance.now() - durationMs;
    let bucket = this.#requests.get(channel);
    if (!bucket) {
      bucket = { busy: [], idle: [] };
      this.#requests.set(channel, bucket);
    }
    (busy ? bucket.busy : bucket.idle).push(durationMs);
  }

  /** Emit and reset the window summaries. */
  report(): void {
    this.#log({
      event: "event_loop_delay",
      p50_ms: nsToMs(this.#window.percentile(50)),
      p99_ms: nsToMs(this.#window.percentile(99)),
      max_ms: nsToMs(this.#window.max),
    });
    this.#window.reset();
    for (const [channel, bucket] of this.#requests)
      this.#log({
        event: "request_latency",
        channel,
        during_tick: summary(bucket.busy),
        idle: summary(bucket.idle),
      });
    this.#requests.clear();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#window.disable();
  }
}

let current: TickProfiler | undefined;

/** Install (or with `undefined`, remove) the process-wide profiler. */
export function setTickProfiler(profiler: TickProfiler | undefined): void {
  current = profiler;
}

export function tickProfiler(): TickProfiler | undefined {
  return current;
}

let sync: (() => void) | undefined;

/**
 * C-265: install (or with `undefined`, remove) the hook that turns profiling
 * on or off at the start of every loop tick, so the runtime switch takes
 * effect on the next cycle without a restart.
 */
export function setTickProfileSync(hook: (() => void) | undefined): void {
  sync = hook;
}

/** Remove `hook` only if it is still the installed one. */
export function clearTickProfileSync(hook: () => void): void {
  if (sync === hook) sync = undefined;
}

/** Pass-through unless profiling is on. */
export function profileTick<T>(loop: string, run: () => Promise<T>) {
  sync?.();
  return current ? current.tick(loop, run) : run();
}

export function profileSpan<T>(
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  return current ? current.span(name, run) : run();
}

/** Pass-through unless profiling is on; never yields to the event loop. */
export function profileSpanSync<T>(name: string, run: () => T): T {
  return current ? current.spanSync(name, run) : run();
}

/** `CARDIGAN_TICK_PROFILE=1` turns measurement on; anything else keeps it off. */
export function tickProfileEnabled(env: {
  readonly CARDIGAN_TICK_PROFILE?: string | undefined;
}): boolean {
  return env.CARDIGAN_TICK_PROFILE === "1";
}

export interface TickProfileSwitchOptions {
  /** `CARDIGAN_TICK_PROFILE=1`: measure regardless of the runtime switch. */
  readonly forced: boolean;
  /** The human's runtime switch; read at the start of every loop tick. */
  readonly enabled: () => boolean;
  readonly create: () => TickProfiler;
  /** Wire a new profiler into the host (store observer, ...). */
  readonly attach: (profiler: TickProfiler) => void;
  /** Undo `attach` before the profiler stops. */
  readonly detach: (profiler: TickProfiler) => void;
  /** A failing read keeps the current state; report it once per failure run. */
  readonly onError?: (error: unknown) => void;
}

/**
 * C-265: owns the process-wide profiler. `sync()` creates it when measurement
 * should be on and stops it when it should be off; a tick already running on
 * the old profiler still logs its line.
 */
export class TickProfileSwitch {
  readonly #options: TickProfileSwitchOptions;
  #profiler: TickProfiler | undefined;
  #failing = false;
  #closed = false;

  constructor(options: TickProfileSwitchOptions) {
    this.#options = options;
  }

  get profiler(): TickProfiler | undefined {
    return this.#profiler;
  }

  sync(): void {
    if (this.#closed) return;
    let on = this.#options.forced;
    if (!on) {
      try {
        on = this.#options.enabled();
        this.#failing = false;
      } catch (error) {
        if (!this.#failing) this.#options.onError?.(error);
        this.#failing = true;
        return;
      }
    }
    if (on && !this.#profiler) {
      const profiler = this.#options.create();
      this.#profiler = profiler;
      this.#options.attach(profiler);
      setTickProfiler(profiler);
    } else if (!on && this.#profiler) this.#remove();
  }

  /** Stop measuring for good; later `sync()` calls do nothing. */
  close(): void {
    this.#closed = true;
    if (this.#profiler) this.#remove();
  }

  #remove(): void {
    const profiler = this.#profiler as TickProfiler;
    this.#profiler = undefined;
    if (tickProfiler() === profiler) setTickProfiler(undefined);
    this.#options.detach(profiler);
    profiler.stop();
  }
}

const SHA = /^[0-9a-f]{40}$/u;

/**
 * C-265: the commit the server runs from. A self-deploy release is a detached
 * checkout, so `.git/HEAD` holds the SHA; a branch checkout resolves the loose
 * ref. Anything else (packed refs, worktrees, no Git) is "unknown". Only a
 * 40-hex SHA is ever returned, so no path or file content reaches the logs.
 */
export function releaseSha(
  root = join(dirname(fileURLToPath(import.meta.url)), "../../.."),
): string {
  try {
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    if (SHA.test(head)) return head;
    const ref = /^ref: (refs\/heads\/[A-Za-z0-9._/-]+)$/u.exec(head)?.[1];
    if (ref && !ref.includes(".."))
      return (
        SHA.exec(readFileSync(join(root, ".git", ref), "utf8").trim())?.[0] ??
        "unknown"
      );
  } catch {
    // Not a Git checkout or unreadable: fall through.
  }
  return "unknown";
}
