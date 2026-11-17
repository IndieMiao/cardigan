-- Batch attempts reuse the existing executor recovery projection. Their
-- lifecycle lives in the project stream; card_id identifies the host's
-- representative member for the existing recovery registration key.
CREATE TRIGGER merge_batch_recovery_attempt_insert AFTER INSERT ON events
WHEN NEW.type IN ('merge_batch_check_queued','merge_batch_check_started','merge_batch_check_finished')
 AND NEW.card_id IS NULL
 AND json_extract(NEW.doc,'$.actor.kind')='system'
 AND json_extract(NEW.doc,'$.actor.project_id')=NEW.project_id
 AND json_type(NEW.doc,'$.payload.card_id')='text'
 AND json_type(NEW.doc,'$.payload.check.attempt_id')='text'
BEGIN
 INSERT INTO check_recovery_attempts VALUES(
   NEW.project_id,json_extract(NEW.doc,'$.payload.card_id'),
   json_extract(NEW.doc,'$.payload.check.attempt_id'),json_extract(NEW.doc,'$.payload.check'))
 ON CONFLICT(project_id,card_id,attempt_id) DO UPDATE SET doc=excluded.doc;
END;
