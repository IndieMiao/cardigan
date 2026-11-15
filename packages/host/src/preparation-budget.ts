import { AsyncLocalStorage } from "node:async_hooks";
import { RepositoryLockTimeoutError } from "@cardigan/git-service";

export class PreparationQueueTimeout extends Error {
  readonly code = "preparation_queue_timeout";
  constructor() {
    super("工作目录准备排队超时");
  }
}

interface WaitBudget {
  remaining: number;
}
export const preparationBudget = new AsyncLocalStorage<WaitBudget>();

/** Charge only admission/lock waits, never time spent executing Git. */
export async function preparationWait<T>(
  wait: (remaining: number | undefined) => Promise<T>,
): Promise<T> {
  const current = preparationBudget.getStore();
  if (!current) return wait(undefined);
  if (current.remaining <= 0) throw new PreparationQueueTimeout();
  const started = performance.now();
  try {
    return await wait(Math.max(1, Math.ceil(current.remaining)));
  } catch (error) {
    if (error instanceof RepositoryLockTimeoutError)
      throw new PreparationQueueTimeout();
    throw error;
  } finally {
    current.remaining -= performance.now() - started;
  }
}
