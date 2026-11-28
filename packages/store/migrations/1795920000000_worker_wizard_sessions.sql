-- C-846: add-worker wizard sessions, so a Web restart keeps the owner's
-- progress. One row per session; the owner-only document holds the draft,
-- steps and pending preview. Rows past their expiry are removed on read.
CREATE TABLE worker_wizard_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  doc TEXT NOT NULL CHECK (json_valid(doc))
);
