-- M4.4: Git reconciliation findings (M4 plan §3.6, development plan §12.6).
--
-- Reconciliation only reports. Each row remembers when a finding was first
-- seen, when it was last confirmed and when it stopped appearing, so the CLI and
-- the attention view can age a finding without re-deriving the Git state.
--
-- The primary key is a stable finding key (kind + subject), not a random id:
-- re-reporting the same orphan on the next pass updates the same row, and a
-- finding that disappears is resolved instead of deleted.
CREATE TABLE reconcile_findings (
  project_id    TEXT NOT NULL,
  id            TEXT NOT NULL,
  kind          TEXT NOT NULL,
  path          TEXT,
  assignment_id TEXT,
  delivery_id   TEXT,
  detail        TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  resolved_at   TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE INDEX reconcile_findings_open
  ON reconcile_findings (project_id, resolved_at);
