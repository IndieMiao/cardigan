-- Source positions use the same append-only events cursor as CommandEvents.
CREATE TABLE ext_message_channels (
  name TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, epoch TEXT NOT NULL, watermark INTEGER NOT NULL
);
ALTER TABLE feishu_bindings ADD COLUMN watermark INTEGER NOT NULL DEFAULT 0;
-- A reservation survives sender restart, credential rotation and uncertain delivery.
CREATE TABLE ext_message_attempts (channel TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX ext_message_attempts_window ON ext_message_attempts(channel, at);
CREATE INDEX ext_message_pending_group ON ext_message_outbox(channel,digest_id) WHERE status='pending';
