-- Global human actions; no bodies, raw idempotency keys, CLI output or secrets.
CREATE TABLE launch_web_changes (
  operation TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  snapshot TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  installed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE launch_profile_checks (
  id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT
);
CREATE INDEX launch_checks_by_profile ON launch_profile_checks(profile, started_at DESC);

-- Only the bounded public catalog projection is journaled, never YAML or secrets.
ALTER TABLE launch_model_intents ADD COLUMN catalog TEXT;
CREATE TABLE launch_catalog_generation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision INTEGER NOT NULL,
  files TEXT NOT NULL
);
