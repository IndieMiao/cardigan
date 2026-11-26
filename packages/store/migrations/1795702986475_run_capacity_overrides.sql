-- C-792: live per-machine overrides of resource slots and project ceilings.
-- run-capacity.yaml remains the default for anything not listed in `doc`.
CREATE TABLE run_capacity_overrides (
  machine_id TEXT PRIMARY KEY,
  doc TEXT NOT NULL CHECK (json_valid(doc))
);
