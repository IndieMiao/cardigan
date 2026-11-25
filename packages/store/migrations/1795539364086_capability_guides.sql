-- C-725: usage notes for the machine capability catalog. One row per entry:
-- a capability key's main note, its supplement on one machine, or a
-- project-level topic. machine_id is '' unless scope = 'machine'. Only humans
-- and the host write; Agent Tokens never do. Notes hold paths and usage,
-- never credential values (validated in the domain before every write).
CREATE TABLE capability_guides (
  project_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('capability', 'machine', 'project')),
  key TEXT NOT NULL,
  machine_id TEXT NOT NULL DEFAULT '',
  usage_note TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL CHECK (updated_by IN ('human', 'system')),
  PRIMARY KEY (project_id, scope, key, machine_id),
  CHECK ((scope = 'machine') = (machine_id <> ''))
);
