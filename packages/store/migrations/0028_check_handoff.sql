-- Host-only admission facts. No card, delivery or publication state is changed.
CREATE TABLE check_handoff (
  project_id TEXT NOT NULL REFERENCES projects(id),
  target TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  phase TEXT NOT NULL CHECK (phase IN ('draining', 'leased', 'held', 'open')),
  controller TEXT NOT NULL,
  binding TEXT NOT NULL,
  holder TEXT,
  PRIMARY KEY (project_id, target)
);
CREATE UNIQUE INDEX check_handoff_target ON check_handoff(target) WHERE phase <> 'open';
CREATE UNIQUE INDEX check_handoff_project ON check_handoff(project_id) WHERE phase <> 'open';
CREATE TABLE check_handoff_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  target TEXT NOT NULL,
  generation INTEGER NOT NULL,
  action TEXT NOT NULL,
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
