-- Host-only singleton fence shared by deployment and merge-check admission.
CREATE TABLE host_deployment_capacity (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_pid INTEGER NOT NULL,
  owner_start TEXT NOT NULL
);
