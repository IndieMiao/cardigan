-- No session/token column: replacement sessions cannot reset a debit.
CREATE TABLE check_log_debits (
  project_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  PRIMARY KEY (project_id, card_id, attempt_id, assignment_id)
) STRICT;
