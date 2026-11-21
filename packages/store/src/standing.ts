import type { DatabaseSync } from "node:sqlite";
import type {
  Assignment,
  AssignmentId,
  CommandState,
  ProjectId,
  TransactionContext,
} from "@cardigan/domain";
import { applyStandingMode, standingModeFromTools } from "@cardigan/domain";
import { type TokenRecord, tokensForAssignment } from "./tokens.js";

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

/**
 * M4.5 (§7.1, §10.4): PM Office and PM Ops are the standing pm Assignments with
 * `standing_mode` office / ops. The field is written once by `cardigan pm
 * create` and backfilled for older rows at startup, so routing never has to
 * guess from a token again. The token lookup stays as a read-only fallback for
 * a legacy row that a dispatcher tick sees before the startup backfill.
 */
export function standingResolver(
  store: { readonly database: DatabaseSync },
  tokensOf: (
    project: ProjectId,
    assignment: AssignmentId,
  ) => readonly { readonly allowed_tools: readonly string[] }[] = (
    project,
    assignment,
  ) =>
    tokensForAssignment(store.database, project, assignment).map((token) => ({
      allowed_tools: token.allowed_tools,
    })),
) {
  return (
    project: ProjectId,
    kind: "pm_ops" | "pm_office",
    state: CommandState,
  ): AssignmentId | undefined => {
    const want = kind === "pm_office" ? "office" : "ops";
    for (const candidate of state.assignments) {
      if (
        candidate.scope !== "standing" ||
        candidate.role_id !== "pm" ||
        candidate.status !== "active"
      )
        continue;
      // C-244: read tokens only for a legacy row without standing_mode; the
      // token query scans the whole tokens table.
      const newest =
        candidate.standing_mode === undefined
          ? tokensOf(project, candidate.id).at(-1)
          : undefined;
      const mode =
        candidate.standing_mode ??
        (newest === undefined
          ? undefined
          : standingModeFromTools(newest.allowed_tools));
      if (mode === want) return candidate.id;
    }
    return undefined;
  };
}
