import { randomUUID } from "node:crypto";
import {
  type CardId,
  type Clock,
  type MergeBatch,
  type MergeCheckView,
  mergeBatches,
  type ProjectId,
} from "@cardigan/domain";
import { mergeCheckAttemptRunningInTransaction } from "@cardigan/host";
import { loadCommandState } from "@cardigan/mcp-server";
import type { Store, StoreTransactionContext } from "@cardigan/store";
import {
  batchCallHistory,
  callOpened,
  callSettled,
  type RepositoryCall,
  type RepositoryReceipt,
  repositoryCheckWait,
} from "./repository-check-wait.js";

/** Host-only observation journal. A registration is NOT evidence that a push
 * never started. Provider recovery and dispatch fences remain authoritative. */
export class BatchRepositoryCalls {
  constructor(
    private store: Store,
    private clock: Clock,
  ) {}
  begin(batch: MergeBatch, check: MergeCheckView, delays: readonly number[]) {
    return this.store.uow.run((tx) => {
      const events = loadCommandState(tx, batch.project_id).events;
      const current = mergeBatches(events).find((b) => b.id === batch.id);
      const card = batch.members.at(-1)?.card_id;
      if (
        !card ||
        current?.status !== "checking" ||
        current.check?.status !== "queued" ||
        current.check.recheck_requested ||
        current.check.attempt_id !== check.attempt_id
      )
        return { kind: "wait" } as const;
      const { epoch, pending } = batchCallHistory(events, batch);
      const { timeouts, retryAt, exhausted } = repositoryCheckWait(
        events,
        check,
      );
      if (exhausted) return { kind: "exhausted", timeouts } as const;
      if (
        (retryAt && Date.parse(this.clock.now()) < Date.parse(retryAt)) ||
        [...pending.values()].some(
          (call) =>
            call.attempt_id !== check.attempt_id &&
            mergeCheckAttemptRunningInTransaction(
              this.store,
              batch.project_id,
              call.attempt_id,
            ),
        )
      )
        return { kind: "wait" } as const;
      const call: RepositoryCall = {
        call_id: randomUUID(),
        epoch,
        batch_id: batch.id,
        attempt_id: check.attempt_id,
        prior_timeouts: timeouts,
        retry_delays_ms: [...delays],
      };
      this.append(tx, batch.project_id, card, callOpened, call);
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
