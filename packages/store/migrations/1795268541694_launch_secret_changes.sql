-- C-549: secrets.env writes from the Web. Only the variable name, never a value.
-- Rows are never deleted; `status` follows the confirmation's outcome:
-- pending (in flight), applied (proved), not_applied (proved not to have
-- happened) or unconfirmed (not provable either way).
CREATE TABLE launch_secret_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('set', 'clear')),
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'not_applied', 'unconfirmed'))
);
CREATE INDEX launch_secret_changes_by_key ON launch_secret_changes(key, created_at DESC);
-- Q-1094 / Q-1095: a secrets.env change in flight. `write` adds brand-new keys
-- ahead of a launch.yaml publication (`old_keys` are the keys it supersedes,
-- `yaml_before` hashes the YAML text it started from); `clear` removes keys.
-- Key names, paths and a YAML hash only; nothing derived from a value.
CREATE TABLE launch_secret_intents (
  operation TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('write', 'clear')),
  path TEXT NOT NULL,
  temp_path TEXT NOT NULL,
  keys TEXT NOT NULL,
  old_keys TEXT NOT NULL,
  yaml_before TEXT,
  resolved TEXT CHECK (resolved IN ('applied', 'failed', 'unconfirmed')),
  created_at TEXT NOT NULL
);
