import {
  type Clock,
  type ProjectId,
  type RunId,
  refreshRunTargetWait,
} from "@cardigan/domain";
import { loadCommandState, persistEffect, unwrap } from "@cardigan/mcp-server";
import {
  type BellAttempt,
  type Store,
  withdrawBellAttempt,
} from "@cardigan/store";

export class RunTargetDeferred extends Error {
  constructor() {
    super("验证工作项尚无当前可审交付，保留本次执行等待新交付");
  }
}

/** Synchronous check immediately before dispatch/wake, after asynchronous preparation. */
export function refreshTargetWait(
  store: Store,
  project: ProjectId,
  run_id: RunId,
  clock: Clock,
): boolean {
  return store.uow.run((tx) => {
    const effect = unwrap(
      refreshRunTargetWait(
        loadCommandState(tx, project),
        { kind: "system", project_id: project },
        { run_id },
        { clock, ids: tx.ids },
      ),
    );
    persistEffect(tx, project, effect);
    return effect.data;
  });
}

/** The caller has not sent a bell or released a new terminal's start sentinel. */
export function deferTargetAttempt(
  store: Store,
  attempt: BellAttempt,
  clock: Clock,
): boolean {
  return store.uow.run((tx) => {
    if (!withdrawBellAttempt(store.database, attempt.project_id, attempt.id))
      return false;
    persistEffect(
      tx,
      attempt.project_id,
      unwrap(
        refreshRunTargetWait(
          loadCommandState(tx, attempt.project_id),
          { kind: "system", project_id: attempt.project_id },
          { run_id: attempt.run_id, withdrawn_attempt_id: attempt.id },
          { clock, ids: tx.ids },
        ),
      ),
    );
    return true;
  });
}
