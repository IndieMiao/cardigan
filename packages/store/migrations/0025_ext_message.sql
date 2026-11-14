-- Replayable projection: source events remain canonical; no message or secret is stored.
CREATE TABLE ext_message_outbox (
  project_id TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  event_id TEXT NOT NULL,
  card_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','sent','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT NOT NULL,
  lease_id TEXT,
  lease_until TEXT,
  last_error TEXT CHECK (last_error IN ('retryable','permanent','timeout','unknown','adapter_unavailable')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, item_kind, item_id, channel)
);
CREATE INDEX ext_message_due ON ext_message_outbox(project_id, channel, status, next_attempt_at);
CREATE TABLE ext_message_host_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  doc TEXT NOT NULL
);
