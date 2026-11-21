-- C-549: secrets.env writes from the Web. Only the variable name, never a value.
CREATE TABLE launch_secret_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('set', 'clear')),
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX launch_secret_changes_by_key ON launch_secret_changes(key, created_at DESC);
-- V-2708: a secrets.env write in flight. Files are named by inode, launch.yaml
-- by text hash; nothing derived from secrets.env content is stored. Settled
-- (applied or undone) from the files before every launch settings read.
CREATE TABLE launch_secret_intents (
  operation TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  temp_path TEXT NOT NULL,
  after_id TEXT NOT NULL,
  after_stamp TEXT,
  backup_path TEXT,
  yaml_path TEXT,
  yaml_after TEXT,
  created_at TEXT NOT NULL
);
