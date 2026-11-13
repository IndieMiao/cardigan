import type {
  CommandEffect,
  ProjectId,
  RotateStandingPmResult,
} from "@cardigan/domain";
import { persistEffect } from "@cardigan/mcp-server";
import {
  finishBellAttempt,
  reassignNotifications,
  type Store,
  type StoreTransactionContext,
  unfinishedBellAttempts,
} from "@cardigan/store";

/** Shared atomic settlement for human rotation and the restricted deployment path. */
export function persistPmRotation(
  store: Store,
  tx: StoreTransactionContext,
  project_id: ProjectId,
  effect: CommandEffect<RotateStandingPmResult>,
  at: string,
): number {
  const data = effect.data;
  if (data.unchanged) return 0;
  persistEffect(tx, project_id, effect);
  let revoked_tokens = 0;
  for (const token of tx.tokensForAssignment(project_id, data.previous.id))
    if (token.revoked_at === null) {
      if (!tx.revokeToken(token.id)) throw new Error("作废旧 Token 失败");
      revoked_tokens += 1;
    }
  const run_ids = tx.runs
    .list(project_id)
    .filter((r) => r.assignment_id === data.previous.id)
    .map((r) => r.id);
  reassignNotifications(store.database, {
    project_id,
    from: data.previous.id,
    to: data.assignment.id,
    run_ids,
    at,
  });
  // A late result from the old session's bell must not escalate anything.
  for (const attempt of unfinishedBellAttempts(store.database, project_id))
    if (attempt.assignment_id === data.previous.id)
      finishBellAttempt(
        store.database,
        project_id,
        attempt.id,
        "failed",
        new Date(
          Math.max(Date.parse(at), Date.parse(attempt.started_at)),
        ).toISOString(),
      );
  return revoked_tokens;
}
