-- M5.1: the Workbench login (plan phase-1-m5 §0, §3.2; development plan §14).
--
-- The operator is one person on one machine, so both tables are project
-- independent: the password guards the whole Workbench, and every project it
-- shows is behind that one session.
--
-- Only the scrypt hash of the password is stored (`scrypt$N$r$p$salt$hash`),
-- and only the sha256 of a session token. A lost database therefore leaks no
-- usable credential, exactly like the MCP tokens in `tokens`.

-- One row, enforced by the CHECK: `cardigan web set-password` replaces it and
-- never adds a second account (§14: no multi-user in Phase 1).
CREATE TABLE web_credential (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- A login session. `expires_at` is fixed when the session is created (7 days
-- by default); `last_seen_at` only feeds the execution view. `revoked_at`
-- carries logout and "changing the password invalidates every session".
CREATE TABLE web_sessions (
  id_hash      TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);

CREATE INDEX web_sessions_by_expiry ON web_sessions (expires_at);
