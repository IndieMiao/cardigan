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
