import type { DatabaseSync } from "node:sqlite";
import { builtinCardTemplates } from "@cardigan/domain";

/** Used inside the migration/project creation transaction. */
export function seedCardTemplates(db: DatabaseSync, project: string): void {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'card_templates'",
      )
      .get()
  )
    return;
  const insert = db.prepare(
    "INSERT OR IGNORE INTO card_templates (project_id, template_id, version, doc) VALUES (?, ?, ?, ?)",
  );
  for (const template of builtinCardTemplates)
    insert.run(
      project,
      template.id,
      template.version,
      JSON.stringify(template),
    );
}
