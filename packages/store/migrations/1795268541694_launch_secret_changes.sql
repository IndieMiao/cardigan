-- C-549: secrets.env writes from the Web. Only the variable name, never a value.
-- Rows are never deleted; `status` follows the confirmation's outcome:
-- pending (in flight), applied (proved), not_applied (proved not to have
-- taken effect) or unconfirmed (not provable either way). `request_key` is a
-- digest of the session and idempotency key, `snapshot` the previewed version:
-- the same request is answered from here, also after a restart.
CREATE TABLE launch_secret_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('set', 'clear')),
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'not_applied', 'unconfirmed')),
  request_key TEXT,
  snapshot TEXT
);
CREATE INDEX launch_secret_changes_by_key ON launch_secret_changes(key, created_at DESC);
CREATE INDEX launch_secret_changes_by_request ON launch_secret_changes(request_key);
-- Q-1094 / Q-1095, state matrix C-549#263/#264/#267: a secrets.env change in
-- flight. Ownership is file identity: the operation's own staging directory
-- (`staging_id`, recorded before any secret byte is written), its temp file
-- (`temp_id`, recorded before the rename) and secrets.env right after the
-- rename (`after_stamp`). `phase` records how far it got; `yaml_reserved` is
-- written in the same transaction as the host's receipt reservation.
-- `resolved` is committed on its own and never changes afterwards; key
-- clean-up (`keys_done`) and removing the staging directory follow, and the
-- row goes only once that directory is gone (C-549#320). The
-- owner (process token, pid, start time) and `released` decide who may settle
-- it. Key names and file identities only; nothing derived from a value.
CREATE TABLE launch_secret_intents (
  operation TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('write', 'clear')),
  path TEXT NOT NULL,
  staging TEXT NOT NULL,
  staging_id TEXT,
  temp_id TEXT,
  after_stamp TEXT,
  phase TEXT NOT NULL
    CHECK (phase IN ('reserving', 'staging', 'prepared', 'renamed', 'yaml_reserved')),
  keys TEXT NOT NULL,
  old_keys TEXT NOT NULL,
  request_key TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  owner_start TEXT NOT NULL,
  released INTEGER NOT NULL DEFAULT 0,
  resolved TEXT CHECK (resolved IN ('applied', 'failed', 'unconfirmed')),
  keys_done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
