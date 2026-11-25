import type { DatabaseSync } from "node:sqlite";
import { type HumanAction, inferHumanActionExecutor } from "@cardigan/domain";

export const OPERATOR_ACTIONS_MIGRATION_NAME = "operator_human_actions";

/**
 * C-742 rule 5: open human actions written before `executor` existed follow
 * rule 1. System-raised host actions and actions already handed to internal
 * host ops keep their own flows; an explicit executor is never overwritten. Returns the migrated ids per project.
 */
export function migrateOperatorHumanActions(db: DatabaseSync) {
  const update = db.prepare(
    "UPDATE human_actions SET doc = ? WHERE project_id = ? AND id = ?",
  );
  const migrated: { project_id: string; id: string }[] = [];
  for (const row of db
    .prepare("SELECT project_id, id, doc FROM human_actions")
    .all()) {
    const action = JSON.parse(String(row.doc)) as HumanAction;
    if (
      action.status !== "open" ||
      action.executor !== undefined ||
      action.requested_by === "system" ||
      // Already handed to internal host ops: not 张良's (as in triage).
      (action.triage === "host" && action.host_operator !== "external") ||
      inferHumanActionExecutor({
        instructions: action.instructions,
        why_human: action.why_human,
        ...(action.handoff ? { title: action.handoff.title } : {}),
      }) !== "operator"
    )
      continue;
    update.run(
      JSON.stringify({ ...action, executor: "operator" }),
      String(row.project_id),
      String(row.id),
    );
    migrated.push({ project_id: String(row.project_id), id: String(row.id) });
  }
  return migrated;
}
