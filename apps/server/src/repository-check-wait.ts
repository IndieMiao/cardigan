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
      old.project_id !== batch.project_id ||
      old.base_sha !== batch.base_sha ||
      old.final_tree_sha !== batch.final_tree_sha ||
      old.purpose !== batch.purpose ||
      old.parent_batch_id !== batch.parent_batch_id ||
      old.members.length !== batch.members.length ||
      !old.members.every(
        (m, i) =>
          m.card_id === batch.members[i]?.card_id &&
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

/** The first interrupted batch in this exact lineage anchors its budget. A
 * member's explicit recovery or a batch confirmation starts a separate epoch.
 * Event ids, unlike sequence numbers, can be compared across card streams. */
export function batchWaitEpoch(events: readonly Event[], batch: MergeBatch) {
  const lineage = interruptedPredecessors(events, batch.id);
  const root = [...lineage].at(-1) ?? batch.id;
  lineage.add(batch.id);
  const confirmation = events.findLast(
    (e) =>
      e.type === "merge_batch_requeued" &&
      e.actor.kind === "system" &&
      lineage.has((e.payload as { batch_id: string }).batch_id),
  );
  const resumes = batch.members.map(
    (m) =>
      events.findLast(
        (e) =>
          e.card_id === m.card_id &&
          e.type === "merge_batch_member_resumed" &&
          (e.actor.kind === "human" ||
            (e.actor.kind === "assignment" &&
              e.actor.role_id === "host_ops")) &&
          (e.payload as { completion_id: string }).completion_id ===
            m.completion_id,
      )?.id,
  );
  return JSON.stringify([root, confirmation?.id, resumes]);
}

export const callOpened = "repository_check_call_opened";
export const callSettled = "repository_check_call_settled";
export type RepositoryCall = {
  call_id: string;
  batch_id: string;
  attempt_id: string;
  epoch: string;
  prior_timeouts: number;
  retry_delays_ms: number[];
};
export type RepositoryReceipt = RepositoryCall & {
  ordinal: number;
  outcome: "timeout" | "other";
  retry_at: string | null;
};

export function batchCallHistory(events: readonly Event[], batch: MergeBatch) {
  const epoch = batchWaitEpoch(events, batch);
  const pending = new Map<string, RepositoryCall>();
  let timeout: RepositoryReceipt | undefined;
  let lastCall: RepositoryCall | RepositoryReceipt | undefined;
  for (const e of events) {
    if (
      e.card_id !== batch.members.at(-1)?.card_id ||
      e.actor.kind !== "system" ||
      e.actor.project_id !== batch.project_id ||
      (e.type !== callOpened && e.type !== callSettled)
    )
      continue;
    const call = e.payload as RepositoryReceipt;
    if (call.epoch !== epoch) continue;
    if (e.type === callOpened) {
      pending.set(call.call_id, call);
      lastCall = call;
    } else if (pending.delete(call.call_id)) {
      if (lastCall?.call_id === call.call_id) lastCall = call;
      if (
        call.outcome === "timeout" &&
        (!timeout || timeout.ordinal < call.ordinal)
      )
        timeout = call;
    }
  }
  return { epoch, pending, lastCall, timeout };
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
  let exhausted = false;
  if (
    check?.batch_id &&
    check.status === "queued" &&
    !check.recheck_requested
  ) {
    const batch = mergeBatches(events).find((b) => b.id === check.batch_id);
    if (batch) {
      const { lastCall, timeout } = batchCallHistory(events, batch);
      if (lastCall)
        lastWaitWasLockTimeout =
          lastCall.attempt_id === check.attempt_id &&
          "outcome" in lastCall &&
          lastCall.outcome === "timeout";
      if (timeout) {
        timeouts = timeout.ordinal;
        retryAt = timeout.retry_at ?? undefined;
        exhausted = timeout.retry_at === null;
      }
    }
  }
  return { timeouts, retryAt, exhausted, lastWaitWasLockTimeout };
}
