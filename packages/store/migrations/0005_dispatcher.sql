-- One durable intent precedes each external bell/provision call. An unfinished
-- expired intent is ambiguous delivery, never permission to create another Run.
CREATE TABLE bell_attempts (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  notification_ids TEXT NOT NULL,
  started_at TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT CHECK(outcome IN ('sent', 'failed')),
  PRIMARY KEY(project_id, id),
  FOREIGN KEY(project_id, assignment_id) REFERENCES assignments(project_id, id),
  FOREIGN KEY(project_id, run_id) REFERENCES runs(project_id, id),
  CHECK ((finished_at IS NULL) = (outcome IS NULL))
);
CREATE UNIQUE INDEX bell_attempt_active_assignment ON bell_attempts(project_id, assignment_id)
  WHERE finished_at IS NULL;
