import type { ToolContext } from "../tools/types.js";

/**
 * C-847: a slow write keeps running after the caller stops waiting. The same
 * caller repeating the same call (same idempotency key and parameters) joins
 * the running one instead of verifying again; once it settles the entry is
 * dropped, and a committed result is answered by the idempotency record.
 * A settled failure is not kept: the next attempt evaluates current state.
 */
export class InFlightCalls {
  readonly #calls = new Map<string, Promise<unknown>>();

  /** The running call for `key`, or a new one started by `start`. */
  run<T>(key: string, start: () => Promise<T>): Promise<T> {
    const running = this.#calls.get(key);
    if (running) return running as Promise<T>;
    const call = (async () => start())().finally(() => {
      if (this.#calls.get(key) === call) this.#calls.delete(key);
    });
    // Nobody may be waiting when it fails: never an unhandled rejection.
    call.catch(() => undefined);
    this.#calls.set(key, call);
    return call;
  }

  get size(): number {
    return this.#calls.size;
  }
}

/** One caller's call: same project, Assignment, tool, key and parameters. */
export function inFlightKey(
  context: ToolContext,
  tool: string,
  key: string,
  params: unknown,
): string {
  return JSON.stringify([
    context.identity.actor.project_id,
    context.identity.actor.assignment_id,
    tool,
    key,
    params,
  ]);
}

/**
 * The call's outcome if it settles within `ms`, otherwise `undefined` while
 * it keeps running. A failure inside the budget rejects as usual.
 */
export async function settleWithin<T>(
  call: Promise<T>,
  ms: number,
): Promise<{ readonly value: T } | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      call.then((value) => ({ value })),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
