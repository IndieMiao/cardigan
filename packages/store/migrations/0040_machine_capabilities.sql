-- Host observations are separate from human-managed machine metadata.
CREATE TABLE machine_health (
  project_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  doc TEXT NOT NULL CHECK (json_valid(doc)),
  PRIMARY KEY (project_id, machine_id)
);
CREATE TABLE machine_capabilities (
  project_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  key TEXT NOT NULL,
  version TEXT,
  verified_at TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  PRIMARY KEY (project_id, machine_id, key)
);
