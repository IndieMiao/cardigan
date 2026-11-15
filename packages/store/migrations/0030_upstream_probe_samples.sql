-- Host-completed reachability facts, bound to a digest of trusted probe configuration.
CREATE TABLE upstream_probe_samples (
  provider TEXT PRIMARY KEY,
  configuration_key TEXT NOT NULL,
  doc TEXT NOT NULL
);
