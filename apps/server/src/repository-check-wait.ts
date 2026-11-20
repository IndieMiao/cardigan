import {
  type Event,
  type MergeBatch,
  type MergeCheckView,
  mergeBatches,
} from "@cardigan/domain";

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

/** A temporary hold can retire a queued batch. Keep its backoff if that exact
 * group is formed again; terminal checks (including explicit recovery after
 * exhaustion) and different targets are not predecessor waits. */
function interruptedPredecessors(
  events: readonly Event[],
  id: MergeBatch["id"],
) {
  const batches = mergeBatches(events);
  const index = batches.findIndex((b) => b.id === id),
    batch = batches[index];
  const ids = new Set<string>();
  if (!batch) return ids;
  for (let i = index - 1; i >= 0; i--) {
    const old = batches[i];
    if (
      !old ||
      old.base_sha !== batch.base_sha ||
      old.purpose !== batch.purpose ||
      old.parent_batch_id !== batch.parent_batch_id ||
      old.members.length !== batch.members.length ||
      !old.members.every(
        (m, i) =>
          m.completion_id === batch.members[i]?.completion_id &&
          m.tree_sha === batch.members[i]?.tree_sha,
      )
    )
      continue;
    if (
      old.status !== "aborted" ||
      (old.check && old.check.status !== "interrupted")
    )
      break;
    ids.add(old.id);
  }
  return ids;
}

/** Keep the budget across candidate rebuilds for this completion (or batch).
 * Only the exact unstarted attempt can be resumed; an explicit recheck starts a new budget. */
export function repositoryCheckWait(
  events: readonly Event[],
  check?: MergeCheckView,
) {
  let timeouts = 0;
  // For exact-attempt recovery only: the scheduler records a new wait *before*
  // invoking an executor, so an older timeout cannot certify an unstarted SSH worker.
  let lastWaitWasLockTimeout = false;
  let retryAt: string | undefined;
  if (check?.status === "queued" && !check.recheck_requested) {
    const predecessors =
      check.batch_id && interruptedPredecessors(events, check.batch_id);
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
      if (
        !p ||
        (p.batch_id !== check.batch_id &&
          !(p.batch_id && predecessors?.has(p.batch_id)))
      )
        continue;
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
      if (p.repository_retry_at) {
        timeouts++;
        retryAt = p.repository_retry_at;
      }
      if (p.attempt_id === check.attempt_id) {
        lastWaitWasLockTimeout = p.repository_retry_at !== undefined;
      }
    }
  }
  return { timeouts, retryAt, lastWaitWasLockTimeout };
}
