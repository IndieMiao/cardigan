-- Host-owned projections, initialized once from relevant system facts only.
CREATE TABLE check_recovery_attempts (
  project_id TEXT NOT NULL, card_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
  doc TEXT NOT NULL, PRIMARY KEY(project_id, card_id, attempt_id)
);
CREATE TABLE check_recovery_registrations (
  project_id TEXT NOT NULL, registration_id TEXT NOT NULL, card_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL, candidate_sha TEXT NOT NULL, executor_key TEXT NOT NULL,
  binding TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','manual_attention','cleaned','busy')), result TEXT,
  evidence_key TEXT, next_inspection_at TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(project_id, registration_id), UNIQUE(project_id, card_id, attempt_id)
);
CREATE INDEX check_recovery_due ON check_recovery_registrations(project_id, executor_key, next_inspection_at);
CREATE INDEX check_recovery_history ON events(project_id, type, stream, seq);

INSERT INTO check_recovery_attempts
SELECT project_id, card_id, json_extract(doc,'$.payload.attempt_id'), json_extract(doc,'$.payload')
FROM events e WHERE type IN ('merge_check_queued','merge_check_started','merge_check_finished')
AND json_extract(doc,'$.actor.kind')='system' AND json_extract(doc,'$.actor.project_id')=project_id
AND card_id IS NOT NULL AND json_type(doc,'$.payload.attempt_id')='text'
AND NOT EXISTS (SELECT 1 FROM events newer WHERE newer.project_id=e.project_id AND newer.stream=e.stream
  AND newer.seq>e.seq AND newer.type IN ('merge_check_queued','merge_check_started','merge_check_finished')
  AND json_extract(newer.doc,'$.actor.kind')='system' AND json_extract(newer.doc,'$.actor.project_id')=e.project_id
  AND json_extract(newer.doc,'$.payload.attempt_id')=json_extract(e.doc,'$.payload.attempt_id'));

INSERT OR IGNORE INTO check_recovery_registrations
(project_id,registration_id,card_id,attempt_id,candidate_sha,executor_key,binding)
SELECT project_id,id,card_id,json_extract(doc,'$.payload.attempt_id'),json_extract(doc,'$.payload.candidate_sha'),
 json_extract(doc,'$.payload.executor_key'),json_extract(doc,'$.payload.binding')
FROM events WHERE type='merge_check_checkout_registered'
AND json_extract(doc,'$.actor.kind')='system' AND json_extract(doc,'$.actor.project_id')=project_id
AND card_id IS NOT NULL AND json_type(doc,'$.payload.attempt_id')='text'
AND json_type(doc,'$.payload.candidate_sha')='text' AND json_type(doc,'$.payload.executor_key')='text'
AND json_type(doc,'$.payload.binding')='object' ORDER BY seq;

UPDATE check_recovery_registrations AS r SET result=(
 SELECT json_object('status',json_extract(doc,'$.payload.status'),'reason',json_extract(doc,'$.payload.reason'),
 'processes',json(COALESCE(json_extract(doc,'$.payload.processes'),'[]')))
 FROM events e WHERE e.project_id=r.project_id AND e.card_id=r.card_id
 AND e.type='merge_check_recovery_finished' AND json_extract(doc,'$.actor.kind')='system'
 AND json_extract(doc,'$.actor.project_id')=r.project_id
 AND json_extract(doc,'$.payload.registration_id')=r.registration_id
 AND json_extract(doc,'$.payload.status') IN ('cleaned','manual_attention','busy') ORDER BY seq DESC LIMIT 1
);
UPDATE check_recovery_registrations SET state=json_extract(result,'$.status') WHERE result IS NOT NULL;

CREATE TRIGGER check_recovery_attempt_insert AFTER INSERT ON events
WHEN NEW.type IN ('merge_check_queued','merge_check_started','merge_check_finished')
 AND json_extract(NEW.doc,'$.actor.kind')='system' AND json_extract(NEW.doc,'$.actor.project_id')=NEW.project_id
 AND NEW.card_id IS NOT NULL AND json_type(NEW.doc,'$.payload.attempt_id')='text'
BEGIN
 INSERT INTO check_recovery_attempts VALUES(NEW.project_id,NEW.card_id,json_extract(NEW.doc,'$.payload.attempt_id'),json_extract(NEW.doc,'$.payload'))
 ON CONFLICT(project_id,card_id,attempt_id) DO UPDATE SET doc=excluded.doc;
END;
CREATE TRIGGER check_recovery_registration_insert AFTER INSERT ON events
WHEN NEW.type='merge_check_checkout_registered'
 AND json_extract(NEW.doc,'$.actor.kind')='system' AND json_extract(NEW.doc,'$.actor.project_id')=NEW.project_id
 AND NEW.card_id IS NOT NULL AND json_type(NEW.doc,'$.payload.attempt_id')='text'
 AND json_type(NEW.doc,'$.payload.candidate_sha')='text' AND json_type(NEW.doc,'$.payload.executor_key')='text'
 AND json_type(NEW.doc,'$.payload.binding')='object'
BEGIN
 INSERT OR IGNORE INTO check_recovery_registrations(project_id,registration_id,card_id,attempt_id,candidate_sha,executor_key,binding)
 VALUES(NEW.project_id,NEW.id,NEW.card_id,json_extract(NEW.doc,'$.payload.attempt_id'),json_extract(NEW.doc,'$.payload.candidate_sha'),json_extract(NEW.doc,'$.payload.executor_key'),json_extract(NEW.doc,'$.payload.binding'));
END;
