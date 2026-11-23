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

-- C-609: the deployment's stop decision. While this row stands (and its owner
-- is alive and it is younger than the host's age limit), new managed long
-- operations wait and run on the next server instead of starting just before
-- the stop.
CREATE TABLE host_long_operation_fence (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_pid INTEGER NOT NULL,
  owner_start TEXT NOT NULL,
  owner_machine TEXT NOT NULL,
  since TEXT NOT NULL
);

-- C-609: an install of the same release on the same binding that a restart
-- interrupted resumes once; a second interruption fails as before.
ALTER TABLE worker_helper_upgrades ADD COLUMN resumes INTEGER NOT NULL DEFAULT 0;
