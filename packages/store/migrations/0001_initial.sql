-- M1 initial schema.
--
-- Each entity table keeps its primary-key columns as real columns (so primary
-- keys, foreign keys and uniqueness constraints are enforced by SQLite) plus a
-- `doc` column holding the canonical JSON of the domain entity. Fields that are
-- only ever read through the entity are not duplicated as columns; add one when
-- a query needs to filter or sort on it.
--
-- Identifiers are project-local (§4.1), so every table is keyed by project_id
-- first.

CREATE TABLE cards (
  project_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  doc        TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE work_items (
  project_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  card_id    TEXT NOT NULL,
  doc        TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE assignments (
  project_id   TEXT NOT NULL,
  id           TEXT NOT NULL,
  machine_id   TEXT NOT NULL,
  mcp_token_id TEXT NOT NULL,
  doc          TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

-- UNIQUE(assignment_id, trigger_event_id) is the run idempotency guarantee
-- (development plan §6.1).
CREATE TABLE runs (
  project_id       TEXT NOT NULL,
  id               TEXT NOT NULL,
  assignment_id    TEXT NOT NULL,
  trigger_event_id TEXT NOT NULL,
  doc              TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, assignment_id, trigger_event_id),
  FOREIGN KEY (project_id, assignment_id)
    REFERENCES assignments (project_id, id)
);

CREATE TABLE timeline (
  project_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  card_id    TEXT NOT NULL,
  event_seq  INTEGER NOT NULL,
  doc        TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, card_id) REFERENCES cards (project_id, id)
);

CREATE INDEX timeline_by_card_seq
  ON timeline (project_id, card_id, event_seq);

CREATE TABLE deliveries (
  project_id   TEXT NOT NULL,
  id           TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  doc          TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE reviews (
  project_id  TEXT NOT NULL,
  id          TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  doc         TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE decisions (
  project_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  doc        TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE human_actions (
  project_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  doc        TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE attachments (
  project_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  sha256     TEXT NOT NULL,
  doc        TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE roles (
  project_id   TEXT NOT NULL,
  role_id      TEXT NOT NULL,
  role_version INTEGER NOT NULL,
  doc          TEXT NOT NULL,
  PRIMARY KEY (project_id, role_id, role_version)
);

CREATE TABLE machines (
  project_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  doc        TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

-- Event streams: a card's stream, or the project-level stream (card_id NULL,
-- stream ''). seq is monotonic within a stream and the unique index makes a
-- duplicate or skipped sequence impossible to persist.
CREATE TABLE events (
  project_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  card_id    TEXT,
  stream     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  type       TEXT NOT NULL,
  doc        TEXT NOT NULL,
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, stream, seq),
  FOREIGN KEY (project_id, card_id) REFERENCES cards (project_id, id)
);

CREATE TABLE event_counters (
  project_id TEXT NOT NULL,
  stream     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  PRIMARY KEY (project_id, stream)
);

CREATE TABLE id_counters (
  project_id TEXT NOT NULL,
  kind       TEXT NOT NULL,
  value      INTEGER NOT NULL,
  PRIMARY KEY (project_id, kind)
);

-- Read cursors. ack_events only ever moves acked_seq forward.
CREATE TABLE cursors (
  project_id    TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  card_id       TEXT NOT NULL,
  acked_seq     INTEGER NOT NULL,
  doc           TEXT NOT NULL,
  PRIMARY KEY (project_id, assignment_id, card_id),
  FOREIGN KEY (project_id, assignment_id)
    REFERENCES assignments (project_id, id),
  FOREIGN KEY (project_id, card_id) REFERENCES cards (project_id, id)
);

-- project_id is added to the columns listed in the plan because assignment IDs
-- are project-local (§4.1): two projects both have A-1.
CREATE TABLE idempotency (
  project_id    TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  key           TEXT NOT NULL,
  request_hash  TEXT NOT NULL,
  response      TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (project_id, assignment_id, key)
);

-- Only the sha256 of a token is stored (§9.1).
CREATE TABLE tokens (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  role_version  INTEGER NOT NULL,
  allowed_tools TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  revoked_at    TEXT
);
