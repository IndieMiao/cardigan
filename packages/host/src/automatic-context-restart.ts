import {
  automaticContextActionForRun,
  type Clock,
  type CommandEffect,
  type ProjectId,
  type RunId,
  recordAutomaticContextRestartResult,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import {
  recordNotification,
  type Store,
  type StoreTransactionContext,
} from "@cardigan/store";

/** Called in the same write transaction as the result, so restart cannot lose the notice. */
export function notifyAutomaticContextResult(
  store: Store,
  project: ProjectId,
  effect: Pick<CommandEffect<unknown>, "events">,
) {
  for (const event of effect.events) {
    if (event.type !== "context_session_restart_result") continue;
    const recipients =
      (event.payload as { result?: string }).result === "failed"
        ? (["pm_ops", "pm_office", "needs_you"] as const)
        : (event.payload as { dispatch_stall_id?: string }).dispatch_stall_id
          ? (["pm_ops", "pm_office"] as const)
          : (["pm_ops"] as const);
    for (const kind of recipients)
      recordNotification(store.database, {
        project_id: project,
        event_id: event.id,
        seq: event.seq,
        at: event.created_at,
        kind: kind === "pm_ops" ? "context_usage" : "needs_you",
        recipient: { kind },
      });
  }
}

/** Dispatch failures of this one launch must bypass ordinary automatic retries. */
export function failAutomaticContextRun(
  store: Store,
  project: ProjectId,
  runId: RunId,
  reason: string,
  clock: Clock,
  transaction?: StoreTransactionContext,
): boolean {
  const settle = (tx: StoreTransactionContext) => {
    const state = loadCommandState(tx, project);
    const run = state.runs.find((r) => r.id === runId);
    const action = run && automaticContextActionForRun(state.events, run);
    if (!run || run.started_at || !action) return false;
    const effect = unwrap(
      recordAutomaticContextRestartResult(
        state,
        { kind: "system", project_id: project },
        { action_id: action.action_id, result: "failed", reason },
        { clock, ids: tx.ids },
      ),
    );
    persistEffect(tx, project, effect);
    notifyAutomaticContextResult(store, project, effect);
    return true;
  };
  return transaction ? settle(transaction) : store.uow.run(settle);
}
