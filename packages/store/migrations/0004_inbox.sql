-- M3.3: the router inbox and its cursor (M3 plan §3.2, M3.3).

-- One row per (event, recipient). The unique constraint is what makes
-- "re-processing the same event never notifies twice" a database fact, not a
-- convention: the router can restart from any cursor and the insert is a no-op.
CREATE TABLE notifications (
  project_id      TEXT NOT NULL,
  id              TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  recipient_kind  TEXT NOT NULL,
  -- Set for recipient_kind = 'assignment', NULL for pm_ops / pm_office /
  -- needs_you; part of the unique key so the two recipient forms cannot clash.
  assignment_id   TEXT NOT NULL DEFAULT '',
  card_id         TEXT,
  seq             INTEGER NOT NULL,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  doc             TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, event_id, recipient_kind, assignment_id),
  FOREIGN KEY (project_id, event_id) REFERENCES events (project_id, id)
);

-- The dispatcher polls per recipient (and per status), so both are indexed.
CREATE INDEX notifications_by_recipient
  ON notifications (project_id, recipient_kind, assignment_id, status);

-- One row per (project, stream): the seq of the last event the router consumed
-- in that stream. Event seqs are numbered per stream (`events` is unique on
-- (project_id, stream, seq)), so a single per-project counter would let one
-- card's progress hide another card's events. `stream` is the card id, or the
-- empty string for the project-level stream (PROJECT_EVENT_STREAM). The router
-- only ever moves a row forward (M3.3).
CREATE TABLE router_cursors (
  project_id TEXT NOT NULL,
  stream     TEXT NOT NULL,
  last_seq   INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, stream)
);

-- The watchdog needs "running Assignments with no MCP call since X" without
-- parsing every JSON document (M3.2 wrote the fact into the doc as well).
ALTER TABLE assignments ADD COLUMN last_mcp_activity_at TEXT;

CREATE INDEX assignments_by_activity
  ON assignments (project_id, last_mcp_activity_at);
