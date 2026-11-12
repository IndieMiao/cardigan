-- Global machine IDs share capacity across projects. YAML remains the default.
CREATE TABLE run_capacity_limits (
  machine_id TEXT PRIMARY KEY,
  doc TEXT NOT NULL CHECK (json_valid(doc))
);
