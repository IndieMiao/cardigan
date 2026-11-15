import type { Profiler } from "node:inspector";
import { Session } from "node:inspector/promises";

/** Policy is mandatory and has no production defaults pending C-344's decision. */
export interface CpuProfileLimits {
  readonly minDurationMs: number;
  readonly maxDurationMs: number;
  readonly minSamplingIntervalUs: number;
  readonly maxSamplingIntervalUs: number;
}

export interface CpuProfileSession {
  connect(): void;
  enable(): Promise<void>;
  setSamplingInterval(intervalUs: number): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<Profiler.Profile>;
  disable(): Promise<void>;
  disconnect(): void;
}

export type CpuProfileResult =
  | {
      readonly status: "completed";
      readonly profile: Profiler.Profile;
      readonly reason: "duration" | "stopped";
    }
  | {
      readonly status:
        | "busy"
        | "closed"
        | "invalid_request"
        | "cancelled"
        | "failed";
    };

// The inspector profiler belongs to the process, not to a recorder instance.
// Hold this through startup, sampling, stop, disable and disconnect.
let owner: symbol | undefined;

function createSession(): CpuProfileSession {
  const session = new Session();
  return {
    connect: () => session.connect(),
    enable: async () => {
      await session.post("Profiler.enable");
    },
    setSamplingInterval: async (interval) => {
      await session.post("Profiler.setSamplingInterval", { interval });
    },
    start: async () => {
      await session.post("Profiler.start");
    },
    stop: async () => (await session.post("Profiler.stop")).profile,
    disable: async () => {
      await session.post("Profiler.disable");
    },
    disconnect: () => session.disconnect(),
  };
}

// Node timers and inspector's integer interval cannot represent larger values.
// This is an implementation constraint, not the pending production policy.
const representable = (value: number) =>
  Number.isSafeInteger(value) && value > 0 && value <= 2 ** 31 - 1;

function waitForSample(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, durationMs);
    timer.unref();
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

/**
 * Internal foundation only: no config reader, CLI, server wiring or file IO.
 * Construction never connects inspector. Capture needs explicit policy and
 * request values. Graceful stop returns complete data, even for a shorter
 * window; explicit cancellation discards it. Raw inspector errors never leave
 * this boundary. No file is published by this module.
 */
export class CpuProfileRecorder {
  readonly #limits: CpuProfileLimits;
  readonly #session: () => CpuProfileSession;
  #closed = false;
  #pending: Promise<CpuProfileResult> | undefined;
  #abort: AbortController | undefined;

  constructor(
    limits: CpuProfileLimits,
    session: () => CpuProfileSession = createSession,
  ) {
    if (
      !Object.values(limits).every(representable) ||
      !representable(limits.minDurationMs) ||
      !representable(limits.maxDurationMs) ||
      !representable(limits.minSamplingIntervalUs) ||
      !representable(limits.maxSamplingIntervalUs) ||
      limits.minDurationMs > limits.maxDurationMs ||
      limits.minSamplingIntervalUs > limits.maxSamplingIntervalUs
    )
      throw new Error("Invalid CPU profile limits");
    this.#limits = { ...limits };
    this.#session = session;
  }

  record(request: {
    readonly durationMs: number;
    readonly samplingIntervalUs: number;
    readonly signal?: AbortSignal;
  }): Promise<CpuProfileResult> {
    if (this.#closed) return Promise.resolve({ status: "closed" });
    if (owner !== undefined) return Promise.resolve({ status: "busy" });
    const { durationMs, samplingIntervalUs, signal } = request;
    if (
      !representable(durationMs) ||
      durationMs < this.#limits.minDurationMs ||
      durationMs > this.#limits.maxDurationMs ||
      !representable(samplingIntervalUs) ||
      samplingIntervalUs < this.#limits.minSamplingIntervalUs ||
      samplingIntervalUs > this.#limits.maxSamplingIntervalUs
    )
      return Promise.resolve({ status: "invalid_request" });
    if (signal?.aborted) return Promise.resolve({ status: "cancelled" });

    const token = Symbol();
    owner = token;
    const abort = new AbortController();
    this.#abort = abort;
    let disconnected = true;
    const cancel = () => abort.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    this.#pending = this.#capture(
      durationMs,
      samplingIntervalUs,
      abort.signal,
      () => signal?.aborted ?? false,
      () => {
        disconnected = false;
      },
    ).finally(() => {
      signal?.removeEventListener("abort", cancel);
      this.#abort = undefined;
      this.#pending = undefined;
      // An unconfirmed disconnect must never allow a second profiler to start.
      if (owner === token && disconnected) owner = undefined;
    });
    return this.#pending;
  }

  /** Stop an active capture gracefully and await complete data and cleanup. */
  async stop(): Promise<CpuProfileResult | undefined> {
    this.#abort?.abort();
    return this.#pending;
  }

  /** Permanently stop admission, gracefully stop sampling, and await cleanup. */
  async close(): Promise<CpuProfileResult | undefined> {
    this.#closed = true;
    return this.stop();
  }

  async #capture(
    durationMs: number,
    intervalUs: number,
    signal: AbortSignal,
    cancelled: () => boolean,
    disconnectFailed: () => void,
  ): Promise<CpuProfileResult> {
    let session: CpuProfileSession | undefined;
    let enabled = false;
    let result: CpuProfileResult = { status: "cancelled" };
    try {
      session = this.#session();
      session.connect();
      await session.enable();
      enabled = true;
      if (!signal.aborted) await session.setSamplingInterval(intervalUs);
      if (!signal.aborted) {
        await session.start();
        if (!signal.aborted) await waitForSample(durationMs, signal);
        const profile = await session.stop();
        if (!cancelled())
          result = {
            status: "completed",
            profile,
            reason: signal.aborted ? "stopped" : "duration",
          };
      }
    } catch {
      result = { status: "failed" };
    } finally {
      if (enabled) {
        try {
          await session?.disable();
        } catch {
          result = { status: "failed" };
        }
      }
      try {
        session?.disconnect();
      } catch {
        disconnectFailed();
        result = { status: "failed" };
      }
    }
    // Stop/cancellation can race with disable, so check after all awaits.
    if (result.status === "completed") {
      if (cancelled()) return { status: "cancelled" };
      return { ...result, reason: signal.aborted ? "stopped" : "duration" };
    }
    return result;
  }
}
