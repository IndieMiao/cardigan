import type { Run } from "./entities.js";

/** C-738: when a queued preparation retry may launch — its backoff, or an earlier deployment. */
export function preparationRetryReadyAt(run: Run): string | undefined {
  const retry = run.preparation_retry;
  if (!retry) return undefined;
  return retry.expedited &&
    Date.parse(retry.expedited.at) < Date.parse(retry.ready_at)
    ? retry.expedited.at
    : retry.ready_at;
}

/** A queued preparation retry still inside its backoff. */
export function preparationRetryWaiting(run: Run, now: string): boolean {
  const at = preparationRetryReadyAt(run);
  return at !== undefined && Date.parse(now) < Date.parse(at);
}
