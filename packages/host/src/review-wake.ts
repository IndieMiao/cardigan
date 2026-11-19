import {
  type Assignment,
  type Clock,
  type CommandState,
  type Run,
  repairWakeTarget,
  resumableReviewWithdrawal,
  reviewRunWakeDisposition,
} from "@cardigan/domain";
import { loadCommandState } from "@cardigan/mcp-server";
import {
  type BellAttempt,
  bindReviewWake,
  type Store,
  withdrawBellAttempt,
} from "@cardigan/store";
import { deferTargetInTransaction } from "./run-target.js";
import { wakeIsCurrent } from "./wake-guard.js";

/** For live review repairs only. Commit the target with the dispatch/claim;
 * a fresh process can tell pre-send failure from a lost response. */
export function bindRepairAttempt(
  store: Store,
  state: CommandState,
  run: Run,
  attempt: BellAttempt,
): BellAttempt {
  const target = repairWakeTarget(state, run);
  if (!target) return attempt;
  const binding = { delivery_id: target.id, target_sha: target.subject.value };
  if (!bindReviewWake(store.database, attempt, binding))
    throw Error("Repair wake intent is no longer owned");
  return { ...attempt, review_wake: binding };
}

/** This is the final synchronous gate for all live repair sends, after runtime IO
 * for preparation/status. Refusal on pause must leave its receipt before returning. */
export function crossRepairSendBoundary(
  store: Store,
  attempt: BellAttempt,
  owner: Assignment,
  clock: Clock,
  requireReceipt = false,
): "send" | "deferred" | "withdrawn" {
  return store.uow.run((tx) => {
    const state = loadCommandState(tx, attempt.project_id);
    const run = state.runs.find((r) => r.id === attempt.run_id);
    const binding = attempt.review_wake;
    const target = run && repairWakeTarget(state, run);
    if (
      binding &&
      target?.id === binding.delivery_id &&
      target.subject.value === binding.target_sha &&
      run &&
      owner.scope === "work_item" &&
      !state.deliveries.some((d) => d.supersedes === target.id) &&
      target.status !== "superseded" &&
      target.work_item_id === owner.work_item_id
    ) {
      if (reviewRunWakeDisposition(state, owner, run) === "paused") {
        return deferTargetInTransaction(store, tx, state, attempt, clock)
          ? "deferred"
          : "withdrawn";
      }
      if (
        wakeIsCurrent(state, owner, run.id) &&
        (!requireReceipt || resumableReviewWithdrawal(state, owner, run))
      )
        return bindReviewWake(store.database, attempt, binding, clock.now())
          ? "send"
          : "withdrawn";
    }
    withdrawBellAttempt(store.database, attempt.project_id, attempt.id);
    return "withdrawn";
  });
}
