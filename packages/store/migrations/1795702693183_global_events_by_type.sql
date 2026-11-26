-- C-793: the GitHub REST budget journal reads the newest `github_rest_budget`
-- row inside a write transaction. Without this index SQLite scans and sorts the
-- whole host-wide stream (tens of thousands of rows, growing daily); with it the
-- lookup walks the index backwards from the newest row of that type.
CREATE INDEX global_events_by_type ON global_events (type, seq);
