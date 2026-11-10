-- Host runtime accounting, independent of a card's merge workflow/result.
-- The process incarnation fences PID reuse and allows restart-safe reclamation.
CREATE TABLE merge_check_capacity (
  project_id TEXT NOT NULL REFERENCES projects(id),
  attempt_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_start TEXT NOT NULL,
  PRIMARY KEY (project_id, attempt_id)
);
