-- A started attempt is also a dispatch fence, including across process loss.
CREATE TABLE worker_helper_upgrades (
  project_id TEXT NOT NULL, machine_id TEXT NOT NULL, release_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('installing','failed','worker_checked','verified')),
  PRIMARY KEY(project_id,machine_id)
);
