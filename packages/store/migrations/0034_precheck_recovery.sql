-- Author prechecks use the same durable cleanup journal and trusted system facts.
INSERT INTO check_recovery_attempts
SELECT project_id,card_id,json_extract(doc,'$.payload.attempt_id'),json_extract(doc,'$.payload')
FROM events e WHERE type IN ('precheck_queued','precheck_started','precheck_finished')
AND json_extract(doc,'$.actor.kind')='system' AND json_extract(doc,'$.actor.project_id')=project_id
AND card_id IS NOT NULL AND json_type(doc,'$.payload.attempt_id')='text'
AND NOT EXISTS (SELECT 1 FROM events newer WHERE newer.project_id=e.project_id AND newer.stream=e.stream
 AND newer.seq>e.seq AND newer.type IN ('precheck_queued','precheck_started','precheck_finished')
 AND json_extract(newer.doc,'$.actor.kind')='system' AND json_extract(newer.doc,'$.actor.project_id')=e.project_id
 AND json_extract(newer.doc,'$.payload.attempt_id')=json_extract(e.doc,'$.payload.attempt_id'))
ON CONFLICT(project_id,card_id,attempt_id) DO UPDATE SET doc=excluded.doc;

CREATE TRIGGER precheck_recovery_attempt_insert AFTER INSERT ON events
WHEN NEW.type IN ('precheck_queued','precheck_started','precheck_finished')
 AND json_extract(NEW.doc,'$.actor.kind')='system' AND json_extract(NEW.doc,'$.actor.project_id')=NEW.project_id
 AND NEW.card_id IS NOT NULL AND json_type(NEW.doc,'$.payload.attempt_id')='text'
BEGIN
 INSERT INTO check_recovery_attempts VALUES(NEW.project_id,NEW.card_id,json_extract(NEW.doc,'$.payload.attempt_id'),json_extract(NEW.doc,'$.payload'))
 ON CONFLICT(project_id,card_id,attempt_id) DO UPDATE SET doc=excluded.doc;
END;
