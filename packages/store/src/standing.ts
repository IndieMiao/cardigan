import type {
  Assignment,
  ProjectId,
  TransactionContext,
} from "@cardigan/domain";
import { applyStandingMode, standingModeFromTools } from "@cardigan/domain";
import type { TokenRecord } from "./tokens.js";

/**
 * M4.5: give rows written before the `standing_mode` field a mode once
 * (development plan §7.1, §10.4).
 *
 * The mode is inferred from the newest token's tool scope — the same signal M3
 * used on every start — and then written back, so later reads only look at the
 * field. Nothing is inferred for a row that already has a mode, and work-item
 * Assignments are never touched.
 */
type StandingTransaction = Pick<TransactionContext, "assignments"> & {
  tokensForAssignment(
    project_id: ProjectId,
    assignment_id: Assignment["id"],
  ): readonly TokenRecord[];
};

export function backfillStandingModesInTransaction(
  tx: StandingTransaction,
  project_id: ProjectId,
): readonly Assignment[] {
  const updated: Assignment[] = [];
  for (const assignment of tx.assignments.list(project_id)) {
    if (
      assignment.scope !== "standing" ||
      assignment.standing_mode !== undefined
    )
      continue;
    const newest = tx.tokensForAssignment(project_id, assignment.id).at(-1);
    // Without a token there is nothing to infer from; the first issuance
    // stamps the mode (and defaults to the least privileged one).
    if (newest === undefined) continue;
    const stamped = applyStandingMode(
      assignment,
      standingModeFromTools(newest.allowed_tools),
    );
    if (!stamped.ok) continue;
    tx.assignments.put(project_id, stamped.value);
    updated.push(stamped.value);
  }
  return updated;
}
