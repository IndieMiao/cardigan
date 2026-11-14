import { realpathSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { RepositoryLockTimeoutError } from "@cardigan/git-service";
import {
  PreparationQueueTimeout,
  preparationBudget,
  preparationWait,
} from "./preparation-budget.js";
import { acquireRepositoryFlock } from "./repository-lock.js";

export { PreparationQueueTimeout } from "./preparation-budget.js";

export interface PreparationPolicy {
  readonly maxConcurrent: number;
  readonly queueWaitMs: number;
  readonly retryBackoffMs: number;
}

/** Q-475: host configuration only; independent of the system Run limit. */
export function preparationPolicy(
  env: NodeJS.ProcessEnv = process.env,
): PreparationPolicy {
  const read = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
      throw new Error(`${name} must be an integer between 1 and 2147483647`);
    return value;
  };
  return {
    maxConcurrent: read("CARDIGAN_PREPARATION_CONCURRENCY", 2),
    queueWaitMs: read("CARDIGAN_PREPARATION_QUEUE_WAIT_MS", 300_000),
    retryBackoffMs: read("CARDIGAN_PREPARATION_RETRY_BACKOFF_MS", 5_000),
  };
}

interface Waiter {
  readonly repository: string;
  readonly enter: (slot: number) => void;
}
interface Queue {
  readonly waiting: Waiter[];
  readonly slots: Set<number>;
  readonly repositories: Set<string>;
  readonly limit: number;
}
const queues = new Map<string, Queue>();
async function acquireSlot(
  root: string,
  preferred: number,
  limit: number,
  waitMs: number,
) {
  const started = performance.now();
  for (let offset = 0; offset < limit; offset++) {
    if (performance.now() - started >= waitMs)
      throw new PreparationQueueTimeout();
    const slot = (preferred + offset) % limit;
    try {
      return await acquireRepositoryFlock(
        join(root, "locks", `preparation-${slot}.lock`),
        1,
      );
    } catch (error) {
      if (!(error instanceof RepositoryLockTimeoutError)) throw error;
    }
  }
  const remaining = waitMs - (performance.now() - started);
  if (remaining <= 0) throw new PreparationQueueTimeout();
  return acquireRepositoryFlock(
    join(root, "locks", `preparation-${preferred}.lock`),
    Math.ceil(remaining),
  );
}
function pump(queue: Queue) {
  while (queue.slots.size < queue.limit) {
    const index = queue.waiting.findIndex(
      (w) => !queue.repositories.has(w.repository),
    );
    if (index < 0) return;
    const waiter = queue.waiting.splice(index, 1)[0];
    if (!waiter) return;
    let slot = 0;
    while (queue.slots.has(slot)) slot++;
    queue.slots.add(slot);
    queue.repositories.add(waiter.repository);
    waiter.enter(slot);
  }
}

/** A host-wide bounded FIFO, with one active preparation per repository. */
export async function withPreparationQueue<T>(
  dataDir: string,
  repository: string,
  work: () => Promise<T>,
  policy = preparationPolicy(),
): Promise<T> {
  if (preparationBudget.getStore()) return work();
  // Canonicalize before yielding so concurrent filesystem callbacks cannot
  // reorder callers that arrived in FIFO order.
  const root = realpathSync(dataDir);
  let queue = queues.get(root);
  if (queue && queue.limit !== policy.maxConcurrent)
    throw new Error(
      "Preparation concurrency changed while the queue is active",
    );
  if (!queue) {
    queue = {
      waiting: [],
      slots: new Set(),
      repositories: new Set(),
      limit: policy.maxConcurrent,
    };
    queues.set(root, queue);
  }
  const current = queue;
  return preparationBudget.run({ remaining: policy.queueWaitMs }, async () => {
    const slot = await preparationWait(
      (remaining) =>
        new Promise<number>((resolve, reject) => {
          const waiter: Waiter = {
            repository,
            enter: (slot) => {
              clearTimeout(timer);
              resolve(slot);
            },
          };
          const timer = setTimeout(() => {
            const at = current.waiting.indexOf(waiter);
            if (at >= 0) current.waiting.splice(at, 1);
            reject(new PreparationQueueTimeout());
          }, remaining);
          current.waiting.push(waiter);
          pump(current);
        }),
    );
    let unlock: (() => Promise<void>) | undefined;
    try {
      // The same host-owned slot in every server/CLI process. No lease expiry
      // can steal a slot while its holder is still performing filesystem IO.
      if (process.platform === "linux")
        unlock = await preparationWait((remaining) =>
          acquireSlot(
            root,
            slot,
            policy.maxConcurrent,
            remaining ?? policy.queueWaitMs,
          ),
        );
      if ((preparationBudget.getStore()?.remaining ?? 0) <= 0)
        throw new PreparationQueueTimeout();
      return await work();
    } finally {
      try {
        await unlock?.();
      } finally {
        current.slots.delete(slot);
        current.repositories.delete(repository);
        pump(current);
        if (!current.slots.size && !current.waiting.length) queues.delete(root);
      }
    }
  });
}

/** Background queries yield before entering Git; a failed/omitted scan is not an empty scan. */
export async function preparationBusy(dataDir: string): Promise<boolean> {
  const root = await realpath(dataDir);
  const queue = queues.get(root);
  if (queue && (queue.slots.size || queue.waiting.length)) return true;
  if (process.platform !== "linux") return false;
  const files = await readdir(join(root, "locks")).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const file of files.filter((name) =>
    /^preparation-\d+\.lock$/u.test(name),
  )) {
    try {
      await (await acquireRepositoryFlock(join(root, "locks", file), 1))();
    } catch (error) {
      if (error instanceof RepositoryLockTimeoutError) return true;
      throw error;
    }
  }
  return false;
}
