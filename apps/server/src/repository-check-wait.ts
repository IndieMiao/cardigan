import type { Event, MergeCheckView } from "@cardigan/domain";

/** Trusted assembly override; never a card or candidate input. */
export function repositoryRetryDelays(
  delays: readonly number[] = [30_000, 60_000],
) {
  if (
    delays.length > 10 ||
    Array.from(delays).some(
      (ms) => !Number.isSafeInteger(ms) || ms <= 0 || ms > 3_600_000,
    )
  )
    throw new Error("Invalid repository lock backoff");
  return [...delays];
}

/** Keep the budget across candidate rebuilds for this completion (or batch).
 * Only the exact unstarted attempt can be resumed; an explicit recheck starts a new budget. */
export function repositoryCheckWait(
  events: readonly Event[],
  check?: MergeCheckView,
) {
  let timeouts = 0;
  let unstarted = false;
  let retryAt: string | undefined;
  if (check?.status === "queued" && !check.recheck_requested) {
    for (const e of events) {
      if (
        ![
          "merge_check_waiting",
          "merge_check_requeued",
          "merge_batch_requeued",
        ].includes(e.type)
      )
        continue;
      const p = e.payload as {
        completion_id?: string;
        batch_id?: string;
        attempt_id?: string;
        repository_retry_at?: string;
      } | null;
      if (!p || p.batch_id !== check.batch_id) continue;
      if (
        (e.type === "merge_batch_requeued" && check.batch_id) ||
        (e.type === "merge_check_requeued" &&
          p.completion_id === check.completion_id)
      ) {
        timeouts = 0;
        continue;
      }
      if (
        e.type !== "merge_check_waiting" ||
        e.actor.kind !== "system" ||
        p.completion_id !== check.completion_id
      )
        continue;
      if (p.repository_retry_at) timeouts++;
      if (p.attempt_id === check.attempt_id) {
        unstarted = p.repository_retry_at !== undefined;
        if (p.repository_retry_at) retryAt = p.repository_retry_at;
      }
    }
  }
  return { timeouts, retryAt, unstarted };
}
