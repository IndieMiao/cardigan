import { randomUUID } from "node:crypto";
import {
  type CardId,
  type Clock,
  latestMergeCheck,
  type MergeCheckView,
  mergeBatches,
  type ProjectId,
} from "@cardigan/domain";
import { mergeCheckAttemptRunningInTransaction } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import {
  callOpened,
  callSettled,
  type RepositoryCall,
  type RepositoryReceipt,
  type RepositoryTarget,
  repositoryCard,
  repositoryCheckWait,
  targetCallHistory,
} from "./repository-check-wait.js";

/** Host-only observation journal. A registration is NOT evidence that a push
 * never started. Provider recovery and dispatch fences remain authoritative. */
export class RepositoryCheckCalls {
  constructor(
    private store: Store,
    private clock: Clock,
  ) {}
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
      const { timeouts, retryAt, exhausted } = repositoryCheckWait(
        events,
        check,
        target,
        history,
      );
      if (exhausted) return { kind: "exhausted", timeouts } as const;
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
      const delay = call.retry_delays_ms[ordinal - 1];
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
      return receipt;
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
