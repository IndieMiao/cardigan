-- Per configured project/worker binding; independent of administrative status and live slots.
CREATE TABLE worker_preparation_health (
  project_id TEXT NOT NULL, machine_id TEXT NOT NULL, target TEXT NOT NULL,
  failures INTEGER NOT NULL, cooldown_until TEXT,
  PRIMARY KEY (project_id, machine_id, target)
);
