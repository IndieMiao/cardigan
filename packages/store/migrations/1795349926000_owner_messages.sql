-- Separate from Needs You: message bodies exist only until the attempt is claimed.
CREATE TABLE owner_messages (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, card TEXT NOT NULL,
  binding TEXT NOT NULL, body TEXT, summary TEXT NOT NULL, sha256 TEXT NOT NULL,
  accepted INTEGER NOT NULL, attempted INTEGER, deadline INTEGER,
  status TEXT NOT NULL CHECK(status IN ('queued','sending','sent','skipped','failed','unknown')),
  FOREIGN KEY(project, card) REFERENCES cards(project_id, id)
);
CREATE INDEX owner_message_pending ON owner_messages(status,accepted);
CREATE INDEX owner_message_admission ON owner_messages(project,accepted);
CREATE INDEX owner_message_dispatch ON owner_messages(project,attempted);
