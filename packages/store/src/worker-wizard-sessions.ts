import type { DatabaseSync } from "node:sqlite";
import { prepare } from "./statements.js";

/** C-846: one persisted add-worker wizard session; `doc` is opaque here. */
export interface WorkerWizardSessionRow {
  readonly id: string;
  readonly project_id: string;
  /** Milliseconds since the epoch. */
  readonly expires_at: number;
  readonly doc: unknown;
}

export function listWorkerWizardSessions(
  db: DatabaseSync,
): WorkerWizardSessionRow[] {
  return prepare(
    db,
    "SELECT id, project_id, expires_at, doc FROM worker_wizard_sessions ORDER BY id",
  )
    .all()
    .map((row) => ({
      id: String(row.id),
      project_id: String(row.project_id),
      expires_at: Number(row.expires_at),
      doc: JSON.parse(String(row.doc)) as unknown,
    }));
}

export function saveWorkerWizardSession(
  db: DatabaseSync,
  row: WorkerWizardSessionRow,
): void {
  prepare(
    db,
    "INSERT INTO worker_wizard_sessions (id, project_id, expires_at, doc) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, expires_at = excluded.expires_at, doc = excluded.doc",
  ).run(row.id, row.project_id, row.expires_at, JSON.stringify(row.doc));
}

export function deleteWorkerWizardSession(db: DatabaseSync, id: string): void {
  prepare(db, "DELETE FROM worker_wizard_sessions WHERE id = ?").run(id);
}
