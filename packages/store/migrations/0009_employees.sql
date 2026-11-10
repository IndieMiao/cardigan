-- Employees and their audit stream are global, independent of all projects.
CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  name_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  doc TEXT NOT NULL
);
CREATE UNIQUE INDEX employees_active_name ON employees(name_key) WHERE status = 'active';

CREATE TABLE global_counters (
  kind TEXT PRIMARY KEY,
  value INTEGER NOT NULL CHECK (value > 0)
);

CREATE TABLE global_events (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE CHECK (seq > 0),
  type TEXT NOT NULL,
  doc TEXT NOT NULL
);
