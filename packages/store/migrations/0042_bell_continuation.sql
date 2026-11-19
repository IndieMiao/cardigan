-- Before in-turn delivery, a bell intent started or retried a Run. Preserve
-- that policy for existing intents; do not infer it from a later Run state.
ALTER TABLE bell_attempts ADD COLUMN continuation INTEGER NOT NULL DEFAULT 0
  CHECK (continuation IN (0, 1));
