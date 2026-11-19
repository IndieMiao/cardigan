import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquireHcFileSlot } from "./call-lock-helper.js";
import { type HcClient, RuntimeFailure } from "./client.js";

export interface HcCallPolicy {
  readonly concurrency: number;
  readonly queueWaitMs: number;
}
export function hcCallPolicy(
  env: NodeJS.ProcessEnv = process.env,
): HcCallPolicy {
  const read = (key: string, fallback: number) => {
    const n = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(n) || n < 1 || n > 2_147_483_647)
      throw new Error(`${key} must be an integer between 1 and 2147483647`);
    return n;
  };
  return {
    concurrency: read("CARDIGAN_HC_CONCURRENCY", 4),
    queueWaitMs: read("CARDIGAN_HC_QUEUE_WAIT_MS", 30_000),
  };
}
export interface HcCallDiagnostics {
  readonly active: number;
  readonly queued: number;
  readonly completed: number;
  readonly queue_timeouts: number;
  readonly max_concurrent: number;
  readonly queue_wait_ms: number;
  readonly last?: {
    readonly wait_ms: number;
    readonly round_trip_ms: number;
    readonly error_category: string | null;
  };
}
const timeout = () =>
  new RuntimeFailure("runtime_queue_timeout", "hc 调用排队超时，尚未执行命令");
type Waiter = { start(slot: number): void; timer: NodeJS.Timeout };
export class HcCallQueue {
  private readonly active = new Set<number>();
  private readonly waiters: Waiter[] = [];
  private completed = 0;
  private running = 0;
  private expired = 0;
  private last: HcCallDiagnostics["last"];
  constructor(
    readonly policy: HcCallPolicy,
    private readonly acquire?: (
      slot: number,
      remainingMs: number,
    ) => Promise<() => Promise<void>>,
  ) {}
  diagnostics(): HcCallDiagnostics {
    return {
      active: this.running,
      queued: this.waiters.length + this.active.size - this.running,
      completed: this.completed,
      queue_timeouts: this.expired,
      max_concurrent: this.policy.concurrency,
      queue_wait_ms: this.policy.queueWaitMs,
      ...(this.last ? { last: { ...this.last } } : {}),
    };
  }
  private pump() {
    while (this.active.size < this.policy.concurrency && this.waiters.length) {
      const waiter = this.waiters.shift();
      if (!waiter) break;
      clearTimeout(waiter.timer);
      let slot = 0;
      while (this.active.has(slot)) slot++;
      this.active.add(slot);
      waiter.start(slot);
    }
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    const queued = performance.now();
    let slot: number | undefined,
      release: (() => Promise<void>) | undefined,
      started: number | undefined;
    let category: string | null = null;
    try {
      slot = await new Promise<number>((accept, reject) => {
        const waiter: Waiter = {
          start: accept,
          timer: setTimeout(() => {
            const at = this.waiters.indexOf(waiter);
            if (at >= 0) this.waiters.splice(at, 1);
            reject(timeout());
          }, this.policy.queueWaitMs),
        };
        this.waiters.push(waiter);
        this.pump();
      });
      const remaining = this.policy.queueWaitMs - (performance.now() - queued);
      if (remaining <= 0) throw timeout();
      release = await this.acquire?.(slot, remaining);
      if (performance.now() - queued >= this.policy.queueWaitMs)
        throw timeout();
      started = performance.now();
      this.running++;
      return await work();
    } catch (error) {
      category =
        error instanceof RuntimeFailure ? error.code : "runtime_unavailable";
      if (category === "runtime_queue_timeout") this.expired++;
      throw error;
    } finally {
      const ended = performance.now();
      const last = {
        wait_ms: Math.max(0, (started ?? ended) - queued),
        round_trip_ms: started === undefined ? 0 : Math.max(0, ended - started),
        error_category: category,
      };
      this.last = last;
      this.completed++;
      if (started !== undefined) this.running--;
      try {
        await release?.().catch((error: unknown) => {
          // Retain the command's error and detail if cleanup also fails.
          // The helper already fences its fd before rejecting release.
          if (category === null) {
            last.error_category =
              error instanceof RuntimeFailure
                ? error.code
                : "runtime_unavailable";
            throw error;
          }
        });
      } finally {
        if (slot !== undefined) this.active.delete(slot);
        this.pump();
      }
    }
  }
}

const queues = new Map<string, HcCallQueue>();
const injected = new WeakMap<HcClient, Map<string, HcCallQueue>>();
export interface GovernedHcClient extends HcClient {
  readonly queue: HcCallQueue;
  readonly coreKey: string;
  /** False means the guard declined before the underlying client was called. */
  execIfCurrent(
    args: readonly string[],
    current: () => boolean,
    inspect?: (client: Pick<HcClient, "exec">) => Promise<boolean>,
  ): Promise<boolean>;
}
export function governHcClient(
  client: HcClient,
  options: {
    socket: string;
    session: string;
    policy: HcCallPolicy;
    dataDir?: string;
  },
): GovernedHcClient {
  const coreKey = JSON.stringify([resolve(options.socket), options.session]);
  let registry = queues;
  if (!options.dataDir) {
    registry = injected.get(client) ?? new Map();
    injected.set(client, registry);
  }
  let queue = registry.get(coreKey);
  if (queue && JSON.stringify(queue.policy) !== JSON.stringify(options.policy))
    throw new Error("Conflicting hc queue policy for the same core");
  if (!queue) {
    const root = options.dataDir && join(options.dataDir, "locks");
    const hash = createHash("sha256").update(coreKey).digest("hex");
    queue = new HcCallQueue(
      options.policy,
      root && process.platform === "linux"
        ? async (slot, remaining) => {
            const deadline = performance.now() + remaining;
            await mkdir(root, { recursive: true, mode: 0o700 });
            for (let i = 0; i < options.policy.concurrency; i++) {
              if (performance.now() >= deadline) throw timeout();
              const release = await acquireHcFileSlot(
                join(
                  root,
                  `hc-${hash}-${(slot + i) % options.policy.concurrency}.lock`,
                ),
                1,
                deadline,
                options.policy.queueWaitMs,
              );
              if (release) return release;
            }
            const left = deadline - performance.now();
            if (left <= 0) throw timeout();
            const release = await acquireHcFileSlot(
              join(root, `hc-${hash}-${slot}.lock`),
              left,
              deadline,
              options.policy.queueWaitMs,
            );
            if (!release) throw timeout();
            return release;
          }
        : undefined,
    );
    registry.set(coreKey, queue);
  }
  const shared = queue;
  return {
    coreKey,
    queue: shared,
    available: () => client.available(),
    lines: (args, signal) => client.lines(args, signal),
    execIfCurrent: (args, current, inspect) =>
      shared.run(async () => {
        // Both the FIFO and cross-process slot have been acquired. There must
        // be no await between checking fresh authority and starting raw IO.
        if (inspect && !(await inspect(client))) return false;
        if (!current()) return false;
        await client.exec(args);
        return true;
      }),
    exec: (args, ms) =>
      shared.run(() =>
        ms === undefined ? client.exec(args) : client.exec(args, ms),
      ),
  };
}
