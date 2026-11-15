-- C-339: retries read one Run's durable history in the original timestamp/rowid order.
CREATE INDEX bell_attempt_run_history ON bell_attempts(project_id, run_id, started_at);
