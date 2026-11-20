-- One owner for a physical machine, across projects, listeners, CLI and patrol.
CREATE TABLE machine_check_jobs (
  id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, project_id TEXT NOT NULL,
  kind TEXT NOT NULL, explicitly_requested INTEGER NOT NULL, status TEXT NOT NULL,
  owner_pid INTEGER NOT NULL, owner_start TEXT NOT NULL, doc TEXT NOT NULL
);
CREATE UNIQUE INDEX machine_check_active ON machine_check_jobs(machine_id) WHERE status='running';
CREATE INDEX machine_check_binding ON machine_check_jobs(machine_id, project_id, kind);
