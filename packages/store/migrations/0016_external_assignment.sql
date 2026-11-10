-- Existing JSON documents remain untouched; external is fixed at creation.
CREATE TRIGGER assignment_external_immutable
BEFORE UPDATE OF doc ON assignments
WHEN json_type(OLD.doc, '$.external') IS NOT json_type(NEW.doc, '$.external')
BEGIN
  SELECT RAISE(ABORT, 'Assignment external is immutable');
END;

CREATE TRIGGER assignment_external_insert
BEFORE INSERT ON assignments
WHEN (json_type(NEW.doc, '$.external') IS NOT NULL AND
      json_type(NEW.doc, '$.external') NOT IN ('true', 'false'))
  OR (json_type(NEW.doc, '$.external') = 'true' AND
      (json_extract(NEW.doc, '$.scope') IS NOT 'standing' OR
       json_extract(NEW.doc, '$.standing_mode') IS NOT 'office'))
BEGIN
  SELECT RAISE(ABORT, 'External Assignment requires standing Office');
END;

CREATE TRIGGER assignment_external_update
BEFORE UPDATE OF doc ON assignments
WHEN json_type(NEW.doc, '$.external') = 'true' AND
     (json_extract(NEW.doc, '$.scope') IS NOT 'standing' OR
      json_extract(NEW.doc, '$.standing_mode') IS NOT 'office')
BEGIN
  SELECT RAISE(ABORT, 'External Assignment requires standing Office');
END;
