import { randomUUID } from "node:crypto";
import {
  type CardId,
  type Clock,
  type Event,
  latestMergeCheck,
  type MergeCheckView,
  mergeBatches,
  type ProjectId,
} from "@cardigan/domain";
import { mergeCheckAttemptRunningInTransaction } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  recordNotification,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";
import {
  callOpened,
  callSettled,
  DEFAULT_REPOSITORY_WAIT_ALERT_MS,
  type RepositoryCall,
  type RepositoryReceipt,
  type RepositoryTarget,
  repositoryCard,
  repositoryCheckWait,
  repositoryRetryDelay,
  repositoryWaitOverdue,
  targetCallHistory,
} from "./repository-check-wait.js";

/** Host-only observation journal. A registration is NOT evidence that a push
 * never started. Provider recovery and dispatch fences remain authoritative. */
export class RepositoryCheckCalls {
  constructor(
    private store: Store,
    private clock: Clock,
    private alertAfterMs = DEFAULT_REPOSITORY_WAIT_ALERT_MS,
  ) {
    if (!Number.isSafeInteger(alertAfterMs) || alertAfterMs <= 0)
      throw new Error("Invalid repository wait alert threshold");
  }
  begin(
    target: RepositoryTarget,
    check: MergeCheckView,
    delays: readonly number[],
  ) {
    return this.store.uow.run((tx) => {
      const project = target.project_id;
      const batch = "members" in target ? target : undefined;
      const card = repositoryCard(target);
      if (!card) return { kind: "wait" } as const;
      const events = batch
        ? loadCommandState(tx, project).events
        : tx.events.listAfter(project, card, 0);
      const current = batch
        ? mergeBatches(events).find((b) => b.id === batch.id)
        : undefined;
      const latest = batch
        ? current?.check
        : latestMergeCheck(events, card, check.completion_id);
      if (
        (batch && current?.status !== "checking") ||
        latest?.status !== "queued" ||
        latest.recheck_requested ||
        latest.attempt_id !== check.attempt_id
      )
        return { kind: "wait" } as const;
      const history = targetCallHistory(events, target, check);
      const { timeouts, retryAt } = repositoryCheckWait(
        events,
        check,
        target,
        history,
      );
      if (
        (retryAt && Date.parse(this.clock.now()) < Date.parse(retryAt)) ||
        [...history.pending.values()].some(
          (call) =>
            call.attempt_id !== check.attempt_id &&
            mergeCheckAttemptRunningInTransaction(
              this.store,
              project,
              call.attempt_id,
            ),
        )
      )
        return { kind: "wait" } as const;
      const call: RepositoryCall = {
        call_id: randomUUID(),
        epoch: history.epoch,
        ...(batch
          ? { batch_id: batch.id }
          : { completion_id: check.completion_id }),
        attempt_id: check.attempt_id,
        prior_timeouts: timeouts,
        retry_delays_ms: [...delays],
      };
      this.append(tx, project, card, callOpened, call);
      return { kind: "opened", id: call.call_id } as const;
    });
  }
  settle(
    project: ProjectId,
    card: CardId,
    id: string,
    outcome: RepositoryReceipt["outcome"],
  ) {
    return this.store.uow.run((tx) => {
      // Read the original registration, not the latest batch or its current
      // eligibility. A late/duplicate callback can never resurrect its owner.
      const events = tx.events.listAfter(project, card, 0);
      const previous = events.findLast(
        (e) =>
          e.actor.kind === "system" &&
          e.actor.project_id === project &&
          (e.type === callOpened || e.type === callSettled) &&
          (e.payload as RepositoryCall).call_id === id,
      );
      if (!previous) throw new Error("Missing repository call");
      if (previous.type === callSettled)
        return previous.payload as RepositoryReceipt;
      const call = previous.payload as RepositoryCall;
      // Charge in settlement order, not registration order. Even if a prior
      // host died and its receipt is replayed late, distinct calls never
      // alias the same ordinal. The captured floor includes legacy waits.
      const prior = events.findLast(
        (e) =>
          e.type === callSettled &&
          e.actor.kind === "system" &&
          e.actor.project_id === project &&
          (e.payload as RepositoryReceipt).epoch === call.epoch &&
          (e.payload as RepositoryReceipt).outcome === "timeout",
      )?.payload as RepositoryReceipt | undefined;
      const ordinal =
        Math.max(call.prior_timeouts, prior?.ordinal ?? 0) +
        (outcome === "timeout" ? 1 : 0);
      const delay = repositoryRetryDelay(call.retry_delays_ms, ordinal);
      const receipt: RepositoryReceipt = {
        ordinal,
        ...call,
        outcome,
        retry_at:
          outcome === "timeout" && delay !== undefined
            ? new Date(Date.parse(this.clock.now()) + delay).toISOString()
            : null,
      };
      this.append(tx, project, card, callSettled, receipt);
      if (receipt.outcome === "timeout")
        this.remindHostOps(tx, project, card, events, receipt);
      return receipt;
    });
  }
  /** Contention past the total threshold only reminds host ops, once per wait
   * epoch. The check stays queued and its author is never returned. */
  private remindHostOps(
    tx: StoreTransactionContext,
    project: ProjectId,
    card: CardId,
    events: readonly Event[],
    receipt: RepositoryReceipt,
  ) {
    const mine = (e: Event) =>
      e.actor.kind === "system" &&
      e.actor.project_id === project &&
      (e.payload as { epoch?: unknown } | null)?.epoch === receipt.epoch;
    if (events.some((e) => e.type === repositoryWaitOverdue && mine(e))) return;
    const since =
      events.find(
        (e) =>
          e.type === callSettled &&
          mine(e) &&
          (e.payload as RepositoryReceipt).outcome === "timeout",
      )?.created_at ?? this.clock.now();
    const now = this.clock.now();
    const waited = Date.parse(now) - Date.parse(since);
    if (waited < this.alertAfterMs) return;
    const ops = tx.assignments
      .list(project)
      .find(
        (a) =>
          a.status === "active" &&
          a.scope === "standing" &&
          a.role_id === "host_ops",
      );
    const minutes = Math.floor(waited / 60_000);
    const event: Event = {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project, card),
      card_id: card,
      actor: { kind: "system", project_id: project },
      type: repositoryWaitOverdue,
      payload: {
        epoch: receipt.epoch,
        attempt_id: receipt.attempt_id,
        ...(receipt.batch_id ? { batch_id: receipt.batch_id } : {}),
        ...(receipt.completion_id
          ? { completion_id: receipt.completion_id }
          : {}),
        waiting_since: since,
        timeouts: receipt.ordinal,
        retry_at: receipt.retry_at,
        threshold_ms: this.alertAfterMs,
        ...(ops ? { assignment_id: ops.id } : {}),
        body: `候选分发已等待仓库锁 ${minutes} 分钟（${receipt.ordinal} 次超时），检查仍在排队重试，请主机运维排查占锁原因。`,
      },
      created_at: now,
    };
    tx.events.append(project, event);
    recordNotification(this.store.database, {
      project_id: project,
      card_id: card,
      event_id: event.id,
      seq: event.seq,
      recipient: ops
        ? { kind: "assignment", assignment_id: ops.id }
        : { kind: "pm_ops" },
      kind: "run_attention",
      at: now,
    });
  }
  private append(
    tx: StoreTransactionContext,
    project: ProjectId,
    card: CardId,
    type: string,
    payload: RepositoryCall | RepositoryReceipt,
  ) {
    tx.events.append(project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(project, card),
      card_id: card,
      actor: { kind: "system", project_id: project },
      type,
      payload,
      created_at: this.clock.now(),
    });
  }
}
