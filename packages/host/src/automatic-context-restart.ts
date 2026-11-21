import {
  type Assignment,
  type AssignmentId,
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

export function recoveryPm(target: Assignment | undefined) {
  return target?.scope === "standing" &&
    target.role_id === "pm" &&
    target.standing_mode === "ops"
    ? ("pm_office" as const)
    : ("pm_ops" as const);
}

/** Called in the same write transaction as the result, so restart cannot lose the notice. */
export function notifyAutomaticContextResult(
  store: Store,
  project: ProjectId,
  effect: Pick<CommandEffect<unknown>, "events">,
  tx: StoreTransactionContext,
) {
  for (const event of effect.events) {
    const pmOnly =
      (event.type === "host_ops_action_deferred" &&
        (event.payload as { notify_pm?: boolean }).notify_pm) ||
      (event.type === "context_session_restart_result" &&
        (event.payload as { system_finished_run_id?: string })
          .system_finished_run_id);
    if (pmOnly && (event.payload as { result?: string }).result === "succeeded")
      continue;
    if (!pmOnly && event.type !== "context_session_restart_result") continue;
    const recipients = pmOnly
      ? [
          recoveryPm(
            tx.assignments.get(
              project,
              (event.payload as { assignment_id: AssignmentId }).assignment_id,
            ),
          ),
        ]
      : (event.payload as { result?: string }).result === "failed"
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
        kind: pmOnly
          ? "run_attention"
          : kind === "pm_ops"
            ? "context_usage"
            : "needs_you",
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
    notifyAutomaticContextResult(store, project, effect, tx);
    return true;
  };
  return transaction ? settle(transaction) : store.uow.run(settle);
}
