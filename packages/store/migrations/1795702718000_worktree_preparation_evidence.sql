-- C-784: host-observed remote worktree preparation, one row per project/worker.
-- Written only by the control host in the transaction that records a started
-- launch whose worktree the host itself prepared; never from an Agent or
-- project input. Same fields as a private worktree-preparation.yaml binding,
-- plus the PATH/env-independent fingerprint that lets the proof survive a Run
-- tool PATH or env edit.
CREATE TABLE worktree_preparation_evidence (
  project_id TEXT NOT NULL, machine_id TEXT NOT NULL,
  target_fingerprint TEXT NOT NULL, preparation_fingerprint TEXT NOT NULL,
  os TEXT NOT NULL, arch TEXT NOT NULL,
  verified_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  PRIMARY KEY (project_id, machine_id)
);
