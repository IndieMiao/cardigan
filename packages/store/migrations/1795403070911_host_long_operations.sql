-- C-609: managed long operations (signing, artifact publication, worker
-- upgrades) that an automatic deployment waits for before stopping the server.
-- Rows are advisory: an owner that is proven dead never delays a deployment,
-- and the supervisor's bounded wait always ends in a deployment.
CREATE TABLE host_long_operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  project_id TEXT NOT NULL,
  card_id TEXT,
  label TEXT NOT NULL,
  started_at TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_start TEXT NOT NULL,
  owner_machine TEXT NOT NULL
);
