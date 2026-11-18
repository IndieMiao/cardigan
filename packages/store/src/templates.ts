import type { DatabaseSync } from "node:sqlite";
import {
  builtinCardTemplates,
  type CardTemplate,
  designCardTemplate,
  uiCardTemplate,
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
  seedUiTemplate(db, project);
}

/** C-444: seed only flow-5 projects; historical cards and definitions stay pinned. */
export function seedUiTemplates(db: DatabaseSync): void {
  for (const row of db
    .prepare("SELECT id FROM projects UNION SELECT project_id AS id FROM cards")
    .all())
    seedUiTemplate(db, String(row.id));
}

function seedUiTemplate(db: DatabaseSync, project: string): void {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'project_preferences'",
      )
      .get()
  )
    return;
  const preferences = db
    .prepare("SELECT doc FROM project_preferences WHERE id = ?")
    .get(project);
  if (preferences && JSON.parse(String(preferences.doc)).flow_version >= 5)
    insertTemplates(db, project, [uiCardTemplate]);
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
