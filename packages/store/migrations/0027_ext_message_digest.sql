-- NULL: immediate; queued: waiting for a quiet-hours digest; UUID: frozen membership.
-- Only identifiers are persisted, never the rendered titles or credentials.
ALTER TABLE ext_message_outbox ADD COLUMN digest_id TEXT;
