-- Source positions use the same append-only events cursor as CommandEvents.
CREATE TABLE ext_message_channels (
  name TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, epoch TEXT NOT NULL, watermark INTEGER NOT NULL
);
ALTER TABLE feishu_bindings ADD COLUMN watermark INTEGER NOT NULL DEFAULT 0;
-- A reservation survives sender restart, credential rotation and uncertain delivery.
-- at is the latest possible dispatch while leased, then the observed completion time.
CREATE TABLE ext_message_attempts (lease TEXT PRIMARY KEY, channel TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX ext_message_attempts_window ON ext_message_attempts(channel, at);
CREATE INDEX ext_message_pending_group ON ext_message_outbox(channel,digest_id) WHERE status='pending';
CREATE INDEX ext_message_active_lease ON ext_message_outbox(lease_id) WHERE lease_id IS NOT NULL;
-- NULL while the quota is exhausted; a finite source position once a slot returns.
CREATE TABLE ext_message_rate_batches (channel TEXT PRIMARY KEY, through INTEGER);
-- Exact ordinary-ready observations share the existing per-destination CAS stamp.
-- Combined with an open rate batch, these retain ownership across bounded scans.
ALTER TABLE ext_message_quiet_overflow ADD COLUMN ordinary TEXT NOT NULL DEFAULT '[]';
