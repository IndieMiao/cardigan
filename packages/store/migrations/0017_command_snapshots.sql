-- Revisions and row tombstones commit/rollback with the entities they describe.
-- Keep only the latest revision of each key, not an ever-growing write log.
CREATE TABLE command_versions (
  project_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (project_id, collection)
);
CREATE TABLE command_rows (
  project_id TEXT NOT NULL,
  collection TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (project_id, collection, entity_key)
);
CREATE INDEX command_rows_since ON command_rows(project_id, collection, version);

-- One contribution per assignment; runs update only their own assignment.
CREATE TABLE assignment_activity (
  project_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  employee_id TEXT,
  last_assigned_at TEXT,
  unfinished_runs INTEGER NOT NULL,
  external_standing INTEGER NOT NULL,
  PRIMARY KEY (project_id, assignment_id)
);
CREATE INDEX assignment_activity_employee ON assignment_activity(employee_id);
-- Triggers and the initial activity projection are installed by migrate.ts,
-- in this same migration transaction.
