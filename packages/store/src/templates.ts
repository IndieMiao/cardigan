import type { DatabaseSync } from "node:sqlite";
import {
  builtinCardTemplates,
  type CardTemplate,
  designCardTemplate,
  storyCardTemplate,
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
  insertTemplates(
    db,
    project,
    builtinCardTemplates.filter((t) => t.id !== "story"),
  );
  seedStoryTemplate(db, project);
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

export function seedStoryTemplates(db: DatabaseSync): void {
  for (const row of db
    .prepare("SELECT id FROM projects UNION SELECT project_id AS id FROM cards")
    .all())
    seedStoryTemplate(db, String(row.id));
}

/** Keep every pinned custom version, including an occupied fallback name. */
function seedStoryTemplate(db: DatabaseSync, project: string): void {
  const rows = db
    .prepare(
      "SELECT DISTINCT template_id FROM card_templates WHERE project_id = ?",
    )
    .all(project);
  const ids = new Set(rows.map((row) => String(row.template_id)));
  const existing = db
    .prepare(
      `SELECT 1 FROM card_templates WHERE project_id = ? AND json_extract(doc, '$.builtin') = 1
     AND (template_id = 'story' OR json_extract(doc, '$.story') = 1) LIMIT 1`,
    )
    .get(project);
  if (existing) return;
  let id: string = storyCardTemplate.id;
  for (let i = 1; ids.has(id); i++)
    id = i === 1 ? "builtin-story" : `builtin-story-${i}`;
  insertTemplates(db, project, [{ ...storyCardTemplate, id }]);
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
