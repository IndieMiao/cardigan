import {
  type Clock,
  type CommandState,
  type ProjectId,
  type RunId,
  refreshRunTargetWait,
  runById,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import {
  type BellAttempt,
  listBellAttempts,
  type Store,
  type StoreTransactionContext,
  unfinishedBellAttempts,
  withdrawBellAttempt,
} from "@cardigan/store";

export class RunTargetDeferred extends Error {
  constructor() {
    super("卡片已暂停或尚无可审交付，保留本次执行等待恢复");
  }
}

/** Synchronous check immediately before dispatch/wake, after asynchronous preparation. */
export function refreshTargetWait(
  store: Store,
  project: ProjectId,
  run_id: RunId,
  clock: Clock,
  attempt?: BellAttempt,
): boolean {
  return store.uow.run((tx) => {
    const state = loadCommandState(tx, project);
    const run = runById(state.runs, run_id);
    // Neither absence of send history nor a timeout proves non-delivery.
    // Domain also checks for a withdrawal receipt from this dispatch.
    const noAttempts =
      !attempt &&
      run?.status === "dispatched" &&
      run.kind === "rework" &&
      run.dispatch_target_wait?.since &&
      !listBellAttempts(store.database, project, run_id).length &&
      !unfinishedBellAttempts(store.database, project, run.assignment_id)
        .length;
    const effect = unwrap(
      refreshRunTargetWait(
        state,
        { kind: "system", project_id: project },
        { run_id, ...(noAttempts ? { no_transport_attempts: true } : {}) },
        { clock, ids: tx.ids },
      ),
    );
    persistEffect(tx, project, effect);
    if (effect.data && attempt)
      deferTargetInTransaction(
        store,
        tx,
        loadCommandState(tx, project),
        attempt,
        clock,
      );
    return effect.data;
  });
}

/** Only the owner of this still-unfinished attempt may attest to a withdrawal. */
export function deferIfTargetWait(
  store: Store,
  attempt: BellAttempt,
  clock: Clock,
) {
  return refreshTargetWait(
    store,
    attempt.project_id,
    attempt.run_id,
    clock,
    attempt,
  );
}

/** The caller has not sent a bell or released a new terminal's start sentinel. */
export function deferTargetAttempt(
  store: Store,
  attempt: BellAttempt,
  clock: Clock,
): boolean {
  return store.uow.run((tx) =>
    deferTargetInTransaction(
      store,
      tx,
      loadCommandState(tx, attempt.project_id),
      attempt,
      clock,
    ),
  );
}

/** The pre-send guard, removal of this exact intent and its proof share a commit. */
export function deferTargetInTransaction(
  store: Store,
  tx: StoreTransactionContext,
  state: CommandState,
  attempt: BellAttempt,
  clock: Clock,
) {
  if (!withdrawBellAttempt(store.database, attempt.project_id, attempt.id))
    return false;
  persistEffect(
    tx,
    attempt.project_id,
    unwrap(
      refreshRunTargetWait(
        state,
        { kind: "system", project_id: attempt.project_id },
        { run_id: attempt.run_id, withdrawn_attempt_id: attempt.id },
        { clock, ids: tx.ids },
      ),
    ),
  );
  return true;
}
