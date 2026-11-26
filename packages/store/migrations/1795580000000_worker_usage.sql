-- C-666: the latest space report of each project's own directories on a
-- worker (worktrees, builds, runs and the volume's free space), as the host
-- observed it through that project's helper. One row per binding.
CREATE TABLE worker_usage (
  project_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  doc TEXT NOT NULL CHECK (json_valid(doc)),
  PRIMARY KEY (project_id, machine_id)
);
