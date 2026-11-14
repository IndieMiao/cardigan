import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join, resolve } from "node:path";
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
      this.last = {
        wait_ms: Math.max(0, (started ?? ended) - queued),
        round_trip_ms: started === undefined ? 0 : Math.max(0, ended - started),
        error_category: category,
      };
      this.completed++;
      if (started !== undefined) this.running--;
      try {
        await release?.();
      } finally {
        if (slot !== undefined) this.active.delete(slot);
        this.pump();
      }
    }
  }
}

/** Linux slot ownership lasts until the client call settles, not a renewable lease. */
async function flockSlot(
  path: string,
  waitMs: number,
): Promise<(() => Promise<void>) | undefined> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.nlink !== 1
    )
      throw new Error("Unsafe hc queue lock");
    const code = await new Promise<number | null>((accept, reject) => {
      const child = spawn(
        "flock",
        [
          "--exclusive",
          "--wait",
          Math.max(0.001, waitMs / 1000).toFixed(3),
          "3",
        ],
        {
          stdio: ["ignore", "ignore", "ignore", handle.fd],
          env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        },
      );
      child.once("error", reject);
      child.once("close", accept);
    });
    if (code === 1) {
      await handle.close();
      return undefined;
    }
    if (code !== 0) throw new Error("hc queue lock failed");
    return () => handle.close();
  } catch (error) {
    await handle.close();
    throw error;
  }
}

const queues = new Map<string, HcCallQueue>();
const injected = new WeakMap<HcClient, Map<string, HcCallQueue>>();
export interface GovernedHcClient extends HcClient {
  readonly queue: HcCallQueue;
  readonly coreKey: string;
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
            await mkdir(root, { recursive: true, mode: 0o700 });
            const start = performance.now();
            for (let i = 0; i < options.policy.concurrency; i++) {
              if (performance.now() - start >= remaining) throw timeout();
              const release = await flockSlot(
                join(
                  root,
                  `hc-${hash}-${(slot + i) % options.policy.concurrency}.lock`,
                ),
                1,
              );
              if (release) return release;
            }
            const left = remaining - (performance.now() - start);
            if (left <= 0) throw timeout();
            const release = await flockSlot(
              join(root, `hc-${hash}-${slot}.lock`),
              left,
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
    exec: (args, ms) =>
      shared.run(() =>
        ms === undefined ? client.exec(args) : client.exec(args, ms),
      ),
  };
}
