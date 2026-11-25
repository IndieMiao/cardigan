import type { DatabaseSync } from "node:sqlite";
import {
  type LocalInputKind,
  type ProjectId,
  suggestProjectCode,
} from "@cardigan/domain";

export const PROJECT_CODES_MIGRATION_NAME = "project_codes";

/** Codes the owner chose for the projects that existed before C-674. */
export const REGISTERED_PROJECT_CODES: Readonly<Record<string, string>> = {
  cardigan: "CDG",
  "sensen-godot": "SEN",
};

/** Source text a suggestion is derived from: the name when it has ASCII letters, else the id. */
export function projectCodeSource(project: {
  readonly id: string;
  readonly name: string;
}): string {
  return /[A-Za-z]/u.test(project.name) ? project.name : project.id;
}

export function projectCodes(db: DatabaseSync): string[] {
  return db
    .prepare("SELECT code FROM projects WHERE code IS NOT NULL")
    .all()
    .map((row) => String(row.code));
}

/**
 * Register a code for every project that has none: the owner's codes first,
 * then suggestions in creation order, so older projects keep the short stem.
 */
export function backfillProjectCodes(db: DatabaseSync): void {
  const rows = db
    .prepare(
      "SELECT id, name FROM projects WHERE code IS NULL ORDER BY created_at, id",
    )
    .all()
    .map((row) => ({ id: String(row.id), name: String(row.name) }));
  const taken = new Set(projectCodes(db));
  const set = db.prepare("UPDATE projects SET code = ? WHERE id = ?");
  const pending = [];
  for (const row of rows) {
    const known = REGISTERED_PROJECT_CODES[row.id];
    if (known !== undefined && !taken.has(known)) {
      set.run(known, row.id);
      taken.add(known);
    } else pending.push(row);
  }
  for (const row of pending) {
    const code = suggestProjectCode(projectCodeSource(row), taken);
    set.run(code, row.id);
    taken.add(code);
  }
}

/** Tables a project-scoped number lives in; merge batches have no row table. */
const ID_TABLES: Partial<Record<LocalInputKind, string>> = {
  card: "cards",
  work_item: "work_items",
  assignment: "assignments",
  run: "runs",
  delivery: "deliveries",
  review: "reviews",
  decision: "decisions",
  human_action: "human_actions",
  attachment: "attachments",
  timeline_entry: "timeline",
};

/**
 * C-675: the projects that have a short number such as `C-34`, so a command
 * without a project can tell an unambiguous number from one several
 * projects share. Unsupported kinds answer an empty list.
 */
export function projectsHoldingId(
  db: DatabaseSync,
  kind: LocalInputKind,
  id: string,
): ProjectId[] {
  const table = ID_TABLES[kind];
  if (table === undefined) return [];
  return db
    .prepare(`SELECT project_id FROM ${table} WHERE id = ? ORDER BY project_id`)
    .all(id)
    .map((row) => String(row.project_id));
}
