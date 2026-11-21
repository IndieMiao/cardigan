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
-- V-2713: a secrets.env write in flight: the operation, the file and its
-- temp file. Whether it took effect is read from the operation's marker line
-- in secrets.env; nothing derived from a value is stored. Settled (audit and
-- receipt only, never the file) at start-up and before every settings read.
CREATE TABLE launch_secret_intents (
  operation TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  temp_path TEXT NOT NULL,
  yaml INTEGER NOT NULL CHECK (yaml IN (0, 1)),
  created_at TEXT NOT NULL
);
