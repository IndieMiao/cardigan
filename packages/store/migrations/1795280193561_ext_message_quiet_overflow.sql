-- Membership observed at quiet time but not yet admitted to the bounded outbox.
-- One checkpoint per destination (including app binding generation); no message content.
CREATE TABLE ext_message_quiet_overflow (
  project_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  stamp TEXT NOT NULL,
  members TEXT NOT NULL,
  PRIMARY KEY (project_id, channel)
);
