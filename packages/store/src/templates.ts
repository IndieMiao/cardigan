import type { DatabaseSync } from "node:sqlite";
import {
  builtinCardTemplates,
  type CardTemplate,
  designCardTemplate,
} from "@cardigan/domain";

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
  insertTemplates(db, project, builtinCardTemplates);
}

/**
 * Migration 0021 (p2v-12 V12a): add design v1 to projects seeded before it
 * existed. Existing versions (including the old artifact v1) are untouched.
 */
export function seedDesignTemplate(db: DatabaseSync): void {
  for (const row of db
    .prepare("SELECT id FROM projects UNION SELECT project_id AS id FROM cards")
    .all())
    insertTemplates(db, String(row.id), [designCardTemplate]);
}

function insertTemplates(
  db: DatabaseSync,
  project: string,
  templates: readonly CardTemplate[],
): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO card_templates (project_id, template_id, version, doc) VALUES (?, ?, ?, ?)",
  );
  for (const template of templates)
    insert.run(
      project,
      template.id,
      template.version,
      JSON.stringify(template),
    );
}
