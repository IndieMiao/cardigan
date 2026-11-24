import type { Event, MergeCheckView } from "./entities.js";
import { eventsForCompletion } from "./event-index.js";
import type { CardId, DeliveryId, MergeBatchId, ProjectId } from "./ids.js";

export interface MergeBatchMember {
  readonly card_id: CardId;
  readonly completion_id: DeliveryId;
  readonly merge_sha: string;
  readonly tree_sha: string;
}
export interface MergeBatch {
  readonly id: MergeBatchId;
  readonly project_id: ProjectId;
  readonly purpose: "main" | "bisect";
  readonly parent_batch_id?: MergeBatchId;
  readonly base_sha: string;
  readonly members: readonly MergeBatchMember[];
  readonly final_sha: string;
  readonly final_tree_sha: string;
  readonly solo: boolean;
  readonly priority: number;
  readonly formed_at: string;
  readonly status:
    | "checking"
    | "passed"
    | "failed"
    | "bisecting"
    | "resolved"
    | "publishing"
    | "published"
    | "aborted";
  readonly check?: MergeCheckView;
  readonly culprit?: CardId;
  readonly published_prefix?: MergeBatchId;
}

/** Queue observations live on the tail member's card stream, not in the
 * batch lifecycle. Only the current queued attempt can display one. */
export function batchQueueWait(events: readonly Event[], batch: MergeBatch) {
  const check = batch.check;
  if (
    batch.status !== "checking" ||
    check?.status !== "queued" ||
    check.recheck_requested
  )
    return undefined;
  const owner = batch.members.at(-1)?.card_id;
  if (!owner) return undefined;
  const wait = events.findLast((e) => {
    if (
      e.type !== "merge_check_waiting" ||
      e.card_id !== owner ||
      e.actor.kind !== "system" ||
      e.actor.project_id !== batch.project_id
    )
      return false;
    const p = e.payload as Partial<MergeCheckView> | null;
    return (
      p?.batch_id === batch.id &&
      p.attempt_id === check.attempt_id &&
      p.completion_id === check.completion_id
    );
  })?.payload as MergeCheckView["queue_wait"];
  return wait && { reason: wait.reason, queued_at: wait.queued_at };
}

/** A check that never started cannot implicate a member or justify a confirmation run. */
export function hasBatchFailureEvidence(check?: MergeCheckView): boolean {
  return (
    !!check &&
    !check.startup_failure &&
    ["failed", "timed_out"].includes(check.status)
  );
}

/** A deferred completion is not a failed card check. Only an explicit recheck
 * releases that exact member; rebuilding a batch or moving main cannot do so. */
export function deferredMergeBatch(
  events: readonly Event[],
  card: CardId,
  completion: DeliveryId,
) {
  const deferred = events.findLast(
    (e) =>
      e.card_id === card &&
      e.actor.kind === "system" &&
      e.type === "merge_batch_member_deferred" &&
      (e.payload as { completion_id?: string }).completion_id === completion,
  );
  if (!deferred) return undefined;
  const { batch_id } = deferred.payload as { batch_id: MergeBatchId };
  const resumed = events.some(
    (e) =>
      e.card_id === card &&
      e.seq > deferred.seq &&
      e.type === "merge_batch_member_resumed" &&
      (e.actor.kind === "human" ||
        (e.actor.kind === "assignment" && e.actor.role_id === "host_ops")) &&
      (e.payload as { batch_id?: string }).batch_id === batch_id &&
      (e.payload as { completion_id?: string }).completion_id === completion,
  );
  return resumed ? undefined : batch_id;
}

/** Drain concurrent probes before retiring their family; never cancel an
 * in-flight check or mistake a startup failure for a failed prefix. */
export function batchStartupFailure(family: readonly MergeBatch[]) {
  return family.find(
    (b) =>
      b.status === "failed" && b.check?.startup_failure === "repository_busy",
  );
}

/**
 * C-652: the project-stream event types of merge queue reads
 * (`merge_queue_configured` or `merge_batch_*`, as the Store's SQL GLOB).
 */
export const isProjectMergeEventType = (type: unknown): boolean =>
  type === "merge_queue_configured" ||
  (typeof type === "string" && type.startsWith("merge_batch_"));

const batchCache = new WeakMap<readonly Event[], readonly MergeBatch[]>();

/** Only host events in this project's stream can establish batch evidence. */
export function mergeBatches(events: readonly Event[]): readonly MergeBatch[] {
  const cached = batchCache.get(events);
  if (cached) return cached;
  const batches = new Map<MergeBatchId, MergeBatch>();
  for (const e of events
    .filter(
      (e) =>
        !e.card_id &&
        e.actor.kind === "system" &&
        e.type.startsWith("merge_batch_"),
    )
    .sort((a, b) => a.seq - b.seq)) {
    if (e.card_id || e.actor.kind !== "system") continue;
    if (e.type === "merge_batch_formed") {
      const batch = e.payload as unknown as MergeBatch;
      if (batch.project_id === e.actor.project_id && !batches.has(batch.id))
        batches.set(batch.id, batch);
      continue;
    }
    const p = e.payload as unknown as {
      batch_id?: MergeBatchId;
      check?: MergeCheckView;
      culprit?: CardId;
      published_prefix?: MergeBatchId;
    };
    const batch = p?.batch_id && batches.get(p.batch_id);
    if (!batch) continue;
    const status = {
      merge_batch_bisect_started: "bisecting",
      merge_batch_culprit_identified: "resolved",
      merge_batch_publishing: "publishing",
      merge_batch_published: "published",
      merge_batch_aborted: "aborted",
      merge_batch_requeued: "checking",
    } as const;
    if (e.type in status)
      batches.set(batch.id, {
        ...batch,
        status: status[e.type as keyof typeof status],
        ...(e.type === "merge_batch_requeued" && batch.check
          ? { check: { ...batch.check, recheck_requested: true } }
          : {}),
        ...(p.culprit ? { culprit: p.culprit } : {}),
        ...(p.published_prefix ? { published_prefix: p.published_prefix } : {}),
      });
    else if (e.type.startsWith("merge_batch_check_") && p.check)
      batches.set(batch.id, {
        ...batch,
        check: p.check,
        status:
          p.check.status === "passed"
            ? "passed"
            : ["failed", "timed_out"].includes(p.check.status)
              ? "failed"
              : "checking",
      });
  }
  const result = [...batches.values()];
  batchCache.set(events, result);
  return result;
}

/** A resolved family retains ownership until its proven prefix has published. */
export function activeMergeFamilies(events: readonly Event[]) {
  const batches = mergeBatches(events);
  return batches.filter(
    (b) =>
      b.purpose === "main" &&
      !["published", "aborted"].includes(b.status) &&
      (b.status !== "resolved" ||
        (b.published_prefix &&
          !batches.some(
            (prefix) =>
              prefix.id === b.published_prefix &&
              ["published", "aborted"].includes(prefix.status),
          ))),
  );
}

export function publishingMergeBatch(events: readonly Event[], card: CardId) {
  return mergeBatches(events).find(
    (batch) =>
      batch.status === "publishing" &&
      batch.members.some((m) => m.card_id === card),
  );
}

export function passedCardCheck(
  events: readonly Event[],
  card: CardId,
  completion: DeliveryId,
) {
  return eventsForCompletion(events, completion)
    .filter(
      (e) =>
        e.card_id === card &&
        e.actor.kind === "system" &&
        e.type === "merge_check_finished",
    )
    .sort((a, b) => b.seq - a.seq)
    .map((e) => e.payload as unknown as MergeCheckView)
    .find(
      (p) =>
        p.completion_id === completion &&
        p.level === "card" &&
        p.status === "passed",
    );
}
