import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { StoreObserver } from "@cardigan/store";
import { currentActivity, trackActivity } from "./activity.js";

/**
 * C-216: opt-in measurement of the periodic loops (dispatcher, merge, cleanup,
 * reconcile, backup, ...). Off by default; when off every hook is a plain
 * pass-through. Output carries loop names, span names and numbers only — never
 * SQL, card text, prompts, tokens or request bodies. C-265: every line also
 * carries `ts` (ISO time) and `sha` (the running release commit, or
 * "unknown"), so a window can be cut by time and version. C-638: ticks are
 * also split by project, and SQLite write-lock waits and holds are
 * summarized by operation (`lock_profile`); project ids and names only.
 */
export type ProfileLine = Readonly<Record<string, unknown>>;

interface ProjectSample {
  wallMs: number;
  uowMs: number;
  uowCount: number;
  lockWaitMs: number;
}

interface TickSample {
  uowMs: number;
  uowCount: number;
  uowMaxMs: number;
  stateMs: number;
  stateCount: number;
  /** C-638: SQLite write-lock wait inside `uowMs`. */
  lockWaitMs: number;
  readonly spans: Map<string, number>;
  readonly projects: Map<string, ProjectSample>;
}

interface LockSamples {
  readonly op: string;
  readonly wait: number[];
  readonly hold: number[];
  timeouts: number;
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

const total = (values: readonly number[]) =>
  round(values.reduce((sum, v) => sum + v, 0));

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

/**
 * C-265: the profiler that owns the tick running in this async context. Spans
 * and store work inside a tick stay attributed to that profiler even after the
 * runtime switch removed it as the process-wide one.
 */
const owner = new AsyncLocalStorage<TickProfiler>();

/**
 * C-265: a single `Store.observe` hook that forwards to the profiler owning
 * the current tick, so switching profilers never detaches a running tick.
 */
export const tickStoreObserver: Required<StoreObserver> = {
  transaction: (kind, ms) =>
    owner.getStore()?.storeObserver.transaction(kind, ms),
  stateBuild: (ms) => owner.getStore()?.storeObserver.stateBuild(ms),
  // C-638: requests have no owning tick; their locks go to the current one.
  writeLock: (waitMs, holdMs) =>
    (owner.getStore() ?? current)?.storeObserver.writeLock(waitMs, holdMs),
};

export class TickProfiler {
  readonly #als = new AsyncLocalStorage<TickSample>();
  readonly #project = new AsyncLocalStorage<ProjectSample>();
  readonly #log: (line: ProfileLine) => void;
  readonly #resolution: number;
  readonly #window: ReturnType<typeof monitorEventLoopDelay>;
  #timer: ReturnType<typeof setInterval> | undefined;
  #active = new Map<string, number>();
  #lastTickEnd = Number.NEGATIVE_INFINITY;
  #requests = new Map<string, Latencies>();
  #locks = new Map<string, LockSamples>();
  #inFlight = 0;
  #retired: (() => void) | undefined;
  #finished = false;

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
  readonly storeObserver: Required<StoreObserver> = {
    transaction: (_kind, ms) => {
      const sample = this.#als.getStore();
      if (!sample) return;
      sample.uowMs += ms;
      sample.uowCount++;
      if (ms > sample.uowMaxMs) sample.uowMaxMs = ms;
      const project = this.#project.getStore();
      if (project) {
        project.uowMs += ms;
        project.uowCount++;
      }
    },
    stateBuild: (ms) => {
      const sample = this.#als.getStore();
      if (!sample) return;
      sample.stateMs += ms;
      sample.stateCount++;
    },
    writeLock: (waitMs, holdMs) => {
      const sample = this.#als.getStore();
      if (sample) sample.lockWaitMs += waitMs;
      const project = this.#project.getStore();
      if (project) project.lockWaitMs += waitMs;
      this.#writeLock(waitMs, holdMs);
    },
  };

  /**
   * C-638: one SQLite write-lock use, grouped by the current loop or request
   * (`currentActivity`), else "other". The repository lock has its own
   * always-on `repository_lock` lines (C-636).
   */
  #writeLock(waitMs: number, holdMs: number | undefined): void {
    if (this.#finished) return;
    const op = currentActivity()?.name ?? "other";
    let samples = this.#locks.get(op);
    if (!samples) {
      samples = { op, wait: [], hold: [], timeouts: 0 };
      this.#locks.set(op, samples);
    }
    samples.wait.push(waitMs);
    if (holdMs === undefined) samples.timeouts++;
    else samples.hold.push(holdMs);
  }

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
      lockWaitMs: 0,
      spans: new Map(),
      projects: new Map(),
    };
    // Event-loop utilization over the tick: 1.0 means the loop never got to
    // serve a timer or socket while this tick ran (it may include other
    // loops' synchronous work that overlapped).
    const elu = performance.eventLoopUtilization();
    this.#active.set(loop, (this.#active.get(loop) ?? 0) + 1);
    this.#inFlight++;
    const started = performance.now();
    try {
      return await owner.run(this, () => this.#als.run(sample, run));
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
        uow_lock_wait_ms: round(sample.lockWaitMs),
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
        ...(sample.projects.size
          ? {
              projects: Object.fromEntries(
                [...sample.projects].map(([id, p]) => [
                  id,
                  {
                    wall_ms: round(p.wallMs),
                    uow_ms: round(p.uowMs),
                    uow_count: p.uowCount,
                    uow_lock_wait_ms: round(p.lockWaitMs),
                  },
                ]),
              ),
            }
          : {}),
      });
      this.#inFlight--;
      if (this.#inFlight === 0 && this.#retired) this.#finish();
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

  /**
   * C-638: attribute a part of the current tick to `project`; wall time and
   * UnitOfWork time add up per project on the `tick_profile` line. Nested
   * calls for the same project count once.
   */
  async project<T>(project: string, run: () => Promise<T> | T): Promise<T> {
    const entry = this.#enterProject(project);
    if (!entry) return run();
    const started = performance.now();
    try {
      return await this.#project.run(entry, run);
    } finally {
      entry.wallMs += performance.now() - started;
    }
  }

  /** Synchronous `project`: adds no await. */
  projectSync<T>(project: string, run: () => T): T {
    const entry = this.#enterProject(project);
    if (!entry) return run();
    const started = performance.now();
    try {
      return this.#project.run(entry, run);
    } finally {
      entry.wallMs += performance.now() - started;
    }
  }

  #enterProject(project: string): ProjectSample | undefined {
    const sample = this.#als.getStore();
    if (!sample) return undefined;
    let entry = sample.projects.get(project);
    if (!entry) {
      entry = { wallMs: 0, uowMs: 0, uowCount: 0, lockWaitMs: 0 };
      sample.projects.set(project, entry);
    }
    return this.#project.getStore() === entry ? undefined : entry;
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
    for (const samples of this.#locks.values())
      this.#log({
        event: "lock_profile",
        lock: "sqlite",
        op: samples.op,
        ...(samples.timeouts ? { timeouts: samples.timeouts } : {}),
        wait: { ...summary(samples.wait), total_ms: total(samples.wait) },
        hold: { ...summary(samples.hold), total_ms: total(samples.hold) },
      });
    this.#locks.clear();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#window.disable();
  }

  /**
   * C-265: measurement was switched off. Ticks already running finish with
   * full attribution; once the last one has logged, the unreported window is
   * flushed (`report()`), the profiler stops and `done` runs. Idempotent.
   */
  retire(done?: () => void): void {
    if (this.#retired || this.#finished) return;
    this.#retired = done ?? (() => {});
    if (this.#inFlight === 0) this.#finish();
  }

  #finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    const done = this.#retired;
    try {
      this.report();
    } finally {
      this.stop();
      done?.();
    }
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

/**
 * Pass-through unless profiling is on. C-638: the tick is always tracked as
 * a running activity, so a stall names it even with profiling off.
 */
export function profileTick<T>(loop: string, run: () => Promise<T>) {
  sync?.();
  const profiler = current;
  return trackActivity("loop", loop, () =>
    profiler ? profiler.tick(loop, run) : run(),
  );
}

export function profileSpan<T>(
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  const profiler = owner.getStore() ?? current;
  return profiler ? profiler.span(name, run) : run();
}

/** Pass-through unless profiling is on; never yields to the event loop. */
export function profileSpanSync<T>(name: string, run: () => T): T {
  const profiler = owner.getStore() ?? current;
  return profiler ? profiler.spanSync(name, run) : run();
}

/** C-638: pass-through unless the running tick is profiled; see `project`. */
export function profileProject<T>(
  project: string,
  run: () => Promise<T>,
): Promise<T> {
  const profiler = owner.getStore();
  return profiler ? profiler.project(project, run) : run();
}

/** Synchronous `profileProject`; never yields to the event loop. */
export function profileProjectSync<T>(project: string, run: () => T): T {
  const profiler = owner.getStore();
  return profiler ? profiler.projectSync(project, run) : run();
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
  /** Install `tickStoreObserver` while any profiler is alive. */
  readonly attach: () => void;
  /** Remove it once the last (possibly retiring) profiler has finished. */
  readonly detach: () => void;
  /** A failing read keeps the current state; report it once per failure run. */
  readonly onError?: (error: unknown) => void;
}

/**
 * C-265: owns the process-wide profiler. `sync()` creates it when measurement
 * should be on and retires it when it should be off: new ticks stop sampling
 * at once, ticks already running keep full attribution, and the last report
 * window is flushed when they end.
 */
export class TickProfileSwitch {
  readonly #options: TickProfileSwitchOptions;
  #profiler: TickProfiler | undefined;
  #alive = 0;
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
      if (this.#alive++ === 0) this.#options.attach();
      setTickProfiler(profiler);
    } else if (!on && this.#profiler) this.#retire();
  }

  /** Stop measuring for good; later `sync()` calls do nothing. */
  close(): void {
    this.#closed = true;
    if (this.#profiler) this.#retire();
  }

  #retire(): void {
    const profiler = this.#profiler as TickProfiler;
    this.#profiler = undefined;
    if (tickProfiler() === profiler) setTickProfiler(undefined);
    profiler.retire(() => {
      if (--this.#alive === 0) this.#options.detach();
    });
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
