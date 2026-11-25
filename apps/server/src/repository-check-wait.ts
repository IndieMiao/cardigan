import {
  type CardId,
  type Event,
  type MergeBatch,
  type MergeCheckView,
  mergeBatches,
  type ProjectId,
} from "@cardigan/domain";

/** Trusted assembly override; never a card or candidate input. The last
 * delay repeats: lock contention keeps the check queued, it never fails it. */
export function repositoryRetryDelays(
  delays: readonly number[] = [30_000, 60_000],
) {
  if (
    delays.length === 0 ||
    delays.length > 10 ||
    Array.from(delays).some(
      (ms) => !Number.isSafeInteger(ms) || ms <= 0 || ms > 3_600_000,
    )
  )
    throw new Error("Invalid repository lock backoff");
  return [...delays];
}
/** Backoff before retry number `ordinal + 1`; never runs out. */
export function repositoryRetryDelay(
  delays: readonly number[],
  ordinal: number,
) {
  return delays[Math.min(Math.max(ordinal, 1), delays.length) - 1];
}
/** Default total wait before host ops is reminded; the check stays queued. */
export const DEFAULT_REPOSITORY_WAIT_ALERT_MS = 30 * 60_000;
export const repositoryWaitOverdue = "merge_check_repository_wait_overdue";

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
  batch_id?: string;
  completion_id?: string;
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

type CardTarget = { project_id: ProjectId; card_id: CardId };
export type RepositoryTarget = MergeBatch | CardTarget;
export function repositoryCard(target: RepositoryTarget) {
  return "members" in target ? target.members.at(-1)?.card_id : target.card_id;
}
export function batchCallHistory(events: readonly Event[], batch: MergeBatch) {
  return callHistory(
    events,
    batch.project_id,
    repositoryCard(batch),
    batchWaitEpoch(events, batch),
  );
}
export function targetCallHistory(
  events: readonly Event[],
  target: RepositoryTarget,
  check: MergeCheckView,
) {
  if ("members" in target) return batchCallHistory(events, target);
  const reset = events.findLast(
    (e) =>
      e.type === "merge_check_requeued" &&
      e.card_id === target.card_id &&
      (e.payload as Partial<MergeCheckView>).completion_id ===
        check.completion_id,
  );
  const epoch = JSON.stringify([
    "card",
    target.card_id,
    check.completion_id,
    reset?.id,
  ]);
  return callHistory(events, target.project_id, target.card_id, epoch);
}
function callHistory(
  events: readonly Event[],
  project: ProjectId,
  card: CardId | undefined,
  epoch: string,
) {
  const pending = new Map<string, RepositoryCall>();
  let timeout: RepositoryReceipt | undefined;
  let lastCall: RepositoryCall | RepositoryReceipt | undefined;
  for (const e of events) {
    if (
      e.card_id !== card ||
      e.actor.kind !== "system" ||
      e.actor.project_id !== project ||
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
  check: MergeCheckView | undefined,
  target: RepositoryTarget,
  history?: ReturnType<typeof targetCallHistory>,
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
        ("card_id" in target && e.card_id !== target.card_id) ||
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
        retryAt = undefined;
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
  if (check?.status === "queued" && !check.recheck_requested) {
    const { lastCall, timeout } =
      history ?? targetCallHistory(events, target, check);
    if (lastCall)
      lastWaitWasLockTimeout =
        lastCall.attempt_id === check.attempt_id &&
        "outcome" in lastCall &&
        lastCall.outcome === "timeout";
    if (timeout) {
      timeouts = timeout.ordinal;
      // A legacy receipt without a deadline (former exhaustion) retries now.
      retryAt = timeout.retry_at ?? undefined;
    }
  }
  return { timeouts, retryAt, lastWaitWasLockTimeout };
}
