import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { HttpRejection } from "./http.js";
import {
  fromReadError,
  type HostFactsReader,
  type WorkbenchReadError,
  type WorkbenchReadOp,
  type WorkbenchReadResult,
} from "./read-ops.js";

/**
 * C-644 defaults (configurable, see `workbenchReadOptionsFromEnv`):
 * - 2 workers. A project always reads in the same worker, so its versions stay
 *   stable between polls and its state is cached once, not once per worker.
 *   C-774: which worker is decided by load, not by a hash of the project id
 *   (see `#laneOf`), so two active projects never share a worker while another
 *   one has fewer active projects.
 * - 64 waiting reads per worker; the 65th answers 503 at once.
 * - 30 s per read, queue wait included. A read that already started is not
 *   killed when it times out: it finishes and warms the worker's cache, and
 *   only then frees its slot. Killing it would make a cold build never finish.
 *   Only a read still running after four timeouts counts as stuck and restarts
 *   its worker.
 */
export const WORKBENCH_READ_DEFAULTS = {
  workers: 2,
  maxQueue: 64,
  timeoutMs: 30_000,
} as const;

export interface WorkbenchReadOptions {
  readonly dbPath: string;
  readonly workers?: number;
  readonly maxQueue?: number;
  readonly timeoutMs?: number;
  /** Tests point at a stub; production uses the built worker beside this file. */
  readonly workerUrl?: URL;
  /** C-774: a project idle this long may move to a less busy worker. */
  readonly affinityIdleMs?: number;
  /**
   * C-774: projects to place and warm at once, busiest first. Their workers
   * start right away and decode the projects' history before reads arrive.
   */
  readonly warmProjects?: readonly string[];
}

/**
 * C-774: a project without reads for 10 minutes no longer counts as active on
 * its worker. Its next read may then move to the worker with the fewest
 * active projects (cold caches once); a busy project never moves.
 */
export const READ_AFFINITY_IDLE_MS = 10 * 60_000;

/** A project's worker, kept while it reads or has read recently. */
interface Affinity {
  lane: number;
  /** Reads queued or running for the project (timed-out ones excluded). */
  pending: number;
  /** When the project last queued or finished a read (`performance.now()`). */
  lastActive: number;
}

/**
 * A read that is still running after this many timeouts (2 min by default) is
 * treated as stuck: its worker is terminated and restarted so the project's
 * later reads are not blocked behind it for good.
 */
const HARD_LIMIT_FACTOR = 4;

/** How long `close()` lets a worker finish its current read before terminating it. */
const CLOSE_GRACE_MS = 10_000;

/** Busy, timed-out or unavailable reads answer 503, which the SPA retries. */
const RETRY_AFTER = { "Retry-After": "1" } as const;

interface Job {
  readonly id: number;
  readonly op: WorkbenchReadOp;
  readonly host: HostFactsReader | undefined;
  readonly queuedAt: number;
  readonly resolve: (result: WorkbenchReadResult) => void;
  readonly reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
  started: boolean;
  settled: boolean;
  /** Queue wait in ms, set when the job reaches its worker. */
  waited?: number;
}

interface Lane {
  worker: Worker | undefined;
  readonly queue: Job[];
  running: Job | undefined;
  /** Restarts a worker whose read outlives `HARD_LIMIT_FACTOR` timeouts. */
  deadline: ReturnType<typeof setTimeout> | undefined;
}

export interface WorkbenchReadStats {
  readonly workers: number;
  readonly running: number;
  readonly queued: number;
  /** C-774: active projects per worker, by worker index. */
  readonly projects: readonly (readonly string[])[];
}

export class WorkbenchReadPool {
  readonly #options: Required<
    Omit<WorkbenchReadOptions, "workerUrl" | "warmProjects">
  > & {
    workerUrl: URL;
  };
  readonly #lanes: Lane[];
  readonly #affinity = new Map<string, Affinity>();
  #serial = 0;
  #closed = false;

  constructor(options: WorkbenchReadOptions) {
    const workers = options.workers ?? WORKBENCH_READ_DEFAULTS.workers;
    const requestedQueue = options.maxQueue ?? WORKBENCH_READ_DEFAULTS.maxQueue;
    const timeoutMs = options.timeoutMs ?? WORKBENCH_READ_DEFAULTS.timeoutMs;
    if (!Number.isSafeInteger(workers) || workers < 1 || workers > 16)
      throw new Error("Workbench read workers must be an integer in 1..16");
    if (!Number.isSafeInteger(requestedQueue))
      throw new Error("Workbench read queue limit must be a whole number");
    // At least one waiting slot: with none, even an idle worker would refuse
    // every read, because a read always queues before it reaches its worker.
    // 0 or a negative limit is raised to 1 (C-657).
    const maxQueue = Math.max(1, requestedQueue);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new Error("Workbench read timeout must be a positive integer");
    const affinityIdleMs = options.affinityIdleMs ?? READ_AFFINITY_IDLE_MS;
    if (!Number.isSafeInteger(affinityIdleMs) || affinityIdleMs < 0)
      throw new Error("Workbench read affinity idle time must be >= 0");
    this.#options = {
      dbPath: options.dbPath,
      workers,
      maxQueue,
      timeoutMs,
      affinityIdleMs,
      workerUrl:
        options.workerUrl ??
        new URL("../../dist/web/read-worker.js", import.meta.url),
    };
    this.#lanes = Array.from({ length: workers }, () => ({
      worker: undefined,
      queue: [],
      running: undefined,
      deadline: undefined,
    }));
    const now = performance.now();
    for (const project of options.warmProjects ?? [])
      this.#laneOf(project, now);
    for (const lane of this.#lanes)
      if (this.#warmList(lane, now).length)
        try {
          this.#start(lane);
        } catch {
          // The lane's first read starts (and warms) its worker instead.
        }
  }

  /** Active projects of a lane, the ones its (new) worker should warm. */
  #warmList(lane: Lane, now: number): string[] {
    const index = this.#lanes.indexOf(lane);
    return [...this.#affinity]
      .filter(([, a]) => a.lane === index && this.#active(a, now))
      .map(([project]) => project);
  }

  stats(): WorkbenchReadStats {
    const now = performance.now();
    const projects = this.#lanes.map((): string[] => []);
    for (const [project, affinity] of this.#affinity)
      if (this.#active(affinity, now)) projects[affinity.lane]?.push(project);
    return {
      workers: this.#lanes.filter((lane) => lane.worker).length,
      running: this.#lanes.filter((lane) => lane.running).length,
      queued: this.#lanes.reduce((n, lane) => n + lane.queue.length, 0),
      projects: projects.map((ids) => ids.sort()),
    };
  }

  /** The worker index the project's next read goes to (tests, diagnostics). */
  laneOf(project: string): number {
    const now = performance.now();
    const known = this.#affinity.get(project);
    return known && this.#active(known, now)
      ? known.lane
      : this.#placement(project, known, now);
  }

  #active(affinity: Affinity, now: number): boolean {
    return (
      affinity.pending > 0 ||
      now - affinity.lastActive < this.#options.affinityIdleMs
    );
  }

  /**
   * C-774: a project keeps its worker while it has reads in flight or read
   * within the idle window, so its reads stay in one worker, in order, against
   * one cache. A new or idle project goes to the worker with the fewest active
   * projects; ties keep its previous worker (warm caches), then the stable
   * hash lane, then the lowest index. With nothing in flight, the moved
   * project's next read starts after its last one finished and reads the same
   * database, so its versions never go back.
   */
  #laneOf(project: string, now: number): Affinity {
    const known = this.#affinity.get(project);
    if (known && this.#active(known, now)) return known;
    const lane = this.#placement(project, known, now);
    const next: Affinity = { lane, pending: 0, lastActive: now };
    this.#affinity.set(project, next);
    // Forget projects idle long enough to be placed afresh anyway.
    for (const [other, affinity] of this.#affinity)
      if (
        affinity.pending === 0 &&
        now - affinity.lastActive >= this.#options.affinityIdleMs * 2
      )
        this.#affinity.delete(other);
    return next;
  }

  #placement(
    project: string,
    known: Affinity | undefined,
    now: number,
  ): number {
    const active = this.#lanes.map(() => 0);
    for (const [other, affinity] of this.#affinity)
      if (other !== project && this.#active(affinity, now))
        active[affinity.lane] = (active[affinity.lane] ?? 0) + 1;
    let lane = known?.lane ?? laneFor(project, this.#lanes.length);
    for (let i = 0; i < active.length; i++)
      if ((active[i] ?? 0) < (active[lane] ?? 0)) lane = i;
    return lane;
  }

  /**
   * Queue one read in its project's worker. Rejections are HttpRejections the
   * route sends as they are; nothing here runs the read on the Web thread.
   */
  read(
    op: WorkbenchReadOp,
    host?: HostFactsReader,
    recordTiming?: (stage: string, ms: number) => void,
  ): Promise<WorkbenchReadResult> {
    if (this.#closed)
      return Promise.reject(
        new HttpRejection(
          503,
          "read_unavailable",
          "服务正在关闭",
          undefined,
          RETRY_AFTER,
        ),
      );
    const queuedAt = performance.now();
    const affinity = this.#laneOf(op.project, queuedAt);
    const lane = this.#lanes[affinity.lane] as Lane;
    if (lane.queue.length >= this.#options.maxQueue)
      return Promise.reject(
        new HttpRejection(
          503,
          "read_busy",
          "读取排队已满，请稍后重试",
          undefined,
          RETRY_AFTER,
        ),
      );
    affinity.pending++;
    affinity.lastActive = queuedAt;
    const released = () => {
      affinity.pending--;
      affinity.lastActive = performance.now();
    };
    return new Promise<WorkbenchReadResult>((resolve, reject) => {
      const job: Job = {
        id: ++this.#serial,
        op,
        host,
        queuedAt,
        resolve: (result) => {
          released();
          for (const [stage, ms] of Object.entries(result.timings))
            recordTiming?.(stage, ms);
          resolve(result);
        },
        reject: (error) => {
          released();
          reject(error);
        },
        timer: undefined,
        started: false,
        settled: false,
      };
      job.timer = setTimeout(() => {
        job.timer = undefined;
        if (!job.started) {
          const at = lane.queue.indexOf(job);
          if (at >= 0) lane.queue.splice(at, 1);
        }
        // C-774: a timed-out read still says where its time went.
        const elapsed = performance.now() - job.queuedAt;
        recordTiming?.("read_queue", job.waited ?? elapsed);
        if (job.waited !== undefined)
          recordTiming?.("read_running", elapsed - job.waited);
        this.#settle(
          job,
          new HttpRejection(
            503,
            "read_timeout",
            "读取超时，请稍后重试",
            undefined,
            RETRY_AFTER,
          ),
        );
      }, this.#options.timeoutMs);
      job.timer.unref?.();
      lane.queue.push(job);
      this.#pump(lane);
    });
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#affinity.clear();
    const workers: Worker[] = [];
    for (const lane of this.#lanes) {
      for (const job of lane.queue.splice(0))
        this.#settle(
          job,
          new HttpRejection(
            503,
            "read_unavailable",
            "服务正在关闭",
            undefined,
            RETRY_AFTER,
          ),
        );
      if (lane.running)
        this.#settle(
          lane.running,
          new HttpRejection(
            503,
            "read_unavailable",
            "服务正在关闭",
            undefined,
            RETRY_AFTER,
          ),
        );
      lane.running = undefined;
      clearLaneDeadline(lane);
      if (lane.worker) workers.push(lane.worker);
      lane.worker = undefined;
    }
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve) => {
            // A worker finishes its current read, then exits; never wait forever.
            const kill = setTimeout(
              () => void worker.terminate(),
              CLOSE_GRACE_MS,
            );
            kill.unref?.();
            worker.once("exit", () => {
              clearTimeout(kill);
              resolve();
            });
            worker.postMessage({ kind: "close" });
          }),
      ),
    );
  }

  #settle(job: Job, outcome: WorkbenchReadResult | Error): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    job.timer = undefined;
    if (outcome instanceof Error) job.reject(outcome);
    else job.resolve(outcome);
  }

  #pump(lane: Lane): void {
    if (this.#closed || lane.running) return;
    const job = lane.queue.shift();
    if (!job) return;
    let worker: Worker;
    try {
      worker = this.#start(lane);
    } catch {
      this.#settle(
        job,
        new HttpRejection(
          503,
          "read_unavailable",
          "读取服务不可用",
          undefined,
          RETRY_AFTER,
        ),
      );
      this.#pump(lane);
      return;
    }
    job.started = true;
    job.waited = performance.now() - job.queuedAt;
    lane.running = job;
    try {
      worker.postMessage({ kind: "read", id: job.id, op: job.op });
      lane.deadline = setTimeout(() => {
        lane.deadline = undefined;
        if (lane.running === job && lane.worker === worker)
          void worker.terminate();
      }, this.#options.timeoutMs * HARD_LIMIT_FACTOR);
      lane.deadline.unref?.();
    } catch (error) {
      // An op that cannot be cloned is a programming error: fail only it.
      lane.running = undefined;
      this.#settle(
        job,
        error instanceof Error ? error : new Error("Workbench read failed"),
      );
      this.#pump(lane);
    }
  }

  #start(lane: Lane): Worker {
    if (lane.worker) return lane.worker;
    const worker = new Worker(this.#options.workerUrl, {
      workerData: { dbPath: this.#options.dbPath },
    });
    lane.worker = worker;
    // C-774: a new or restarted worker warms its projects between reads.
    const warm = this.#warmList(lane, performance.now());
    if (warm.length) worker.postMessage({ kind: "warm", projects: warm });
    const failed = () => {
      if (lane.worker !== worker) return;
      lane.worker = undefined;
      const running = lane.running;
      lane.running = undefined;
      clearLaneDeadline(lane);
      if (running)
        this.#settle(
          running,
          new HttpRejection(
            503,
            "read_unavailable",
            "读取服务不可用",
            undefined,
            RETRY_AFTER,
          ),
        );
      void worker.terminate();
      // The next queued read starts a fresh worker.
      this.#pump(lane);
    };
    worker.on("error", failed);
    worker.on("exit", failed);
    worker.on("message", (message) => {
      if (lane.worker !== worker) return;
      const job = lane.running;
      if (message.kind === "host") {
        // A timed-out read still finishes (to warm the cache) but no longer
        // needs host facts; never spend Web-thread time on it.
        const ask =
          job && !job.settled && job.host
            ? job.host(message.request).catch(() => ({}))
            : Promise.resolve({});
        void ask.then((facts) => {
          if (lane.worker === worker)
            worker.postMessage({ kind: "host", id: message.id, facts });
        });
        return;
      }
      if (message.kind !== "done" || !job || job.id !== message.id) return;
      lane.running = undefined;
      clearLaneDeadline(lane);
      if (message.result)
        this.#settle(job, {
          ...message.result,
          timings: { ...message.result.timings, read_queue: job.waited ?? 0 },
        });
      else
        this.#settle(
          job,
          message.error
            ? fromReadError(message.error as WorkbenchReadError)
            : new Error("Workbench read failed"),
        );
      this.#pump(lane);
    });
    return worker;
  }
}

function clearLaneDeadline(lane: Lane): void {
  if (lane.deadline) clearTimeout(lane.deadline);
  lane.deadline = undefined;
}

/** A project's worker when every worker is equally busy (C-774: tie-break only). */
export function laneFor(project: string, lanes: number): number {
  if (lanes <= 1) return 0;
  return createHash("sha256").update(project).digest().readUInt32BE(0) % lanes;
}

/**
 * `CARDIGAN_WORKBENCH_READ_WORKERS=0` keeps every read on the Web thread (the
 * pre-C-644 behavior); other values override the defaults above.
 */
export function workbenchReadOptionsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
):
  | {
      readonly workers: number;
      readonly maxQueue: number;
      readonly timeoutMs: number;
    }
  | undefined {
  const parse = (name: string, fallback: number, min: number) => {
    const text = env[name]?.trim();
    if (!text) return fallback;
    const value = Number(text);
    if (!/^\d+$/u.test(text) || !Number.isSafeInteger(value) || value < min)
      throw new Error(`${name} 必须是不小于 ${min} 的整数`);
    return value;
  };
  const workers = parse(
    "CARDIGAN_WORKBENCH_READ_WORKERS",
    WORKBENCH_READ_DEFAULTS.workers,
    0,
  );
  if (workers > 16)
    throw new Error("CARDIGAN_WORKBENCH_READ_WORKERS 不能超过 16");
  const maxQueue = parseQueue(env.CARDIGAN_WORKBENCH_READ_QUEUE);
  const timeoutMs = parse(
    "CARDIGAN_WORKBENCH_READ_TIMEOUT_MS",
    WORKBENCH_READ_DEFAULTS.timeoutMs,
    1,
  );
  return workers === 0 ? undefined : { workers, maxQueue, timeoutMs };
}

/** 0 or a negative queue limit is read as 1 (C-657); non-integers are refused. */
function parseQueue(raw: string | undefined): number {
  const text = raw?.trim();
  if (!text) return WORKBENCH_READ_DEFAULTS.maxQueue;
  const value = Number(text);
  if (!/^-?\d+$/u.test(text) || !Number.isSafeInteger(value))
    throw new Error("CARDIGAN_WORKBENCH_READ_QUEUE 必须是整数");
  return Math.max(1, value);
}
