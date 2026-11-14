-- Preserve historical Assignment/Run/RuntimeRef documents and hc aliases.
CREATE TRIGGER assignment_machine_insert BEFORE INSERT ON assignments
WHEN NEW.machine_id IS NOT json_extract(NEW.doc, '$.machine_id')
  OR json_type(NEW.doc, '$.machine_id') IS NOT 'text'
  OR length(NEW.machine_id) = 0
  OR EXISTS (SELECT 1 FROM assignments a WHERE a.project_id = NEW.project_id AND a.id = NEW.id
    AND a.machine_id IS NOT NEW.machine_id)
BEGIN SELECT RAISE(ABORT, 'Assignment machine_id must match its document'); END;

CREATE TRIGGER assignment_machine_immutable BEFORE UPDATE ON assignments
WHEN NEW.machine_id IS NOT OLD.machine_id
  OR json_extract(NEW.doc, '$.machine_id') IS NOT json_extract(OLD.doc, '$.machine_id')
  OR NEW.machine_id IS NOT json_extract(NEW.doc, '$.machine_id')
BEGIN SELECT RAISE(ABORT, 'Assignment machine_id is immutable and must match its document'); END;

-- Serialize cross-project physical identity checks under the existing write transaction.
CREATE TRIGGER machine_identity_insert BEFORE INSERT ON machines
WHEN NEW.id IS NOT json_extract(NEW.doc, '$.id') OR EXISTS (
  SELECT 1 FROM machines m WHERE NOT (m.project_id = NEW.project_id AND m.id = NEW.id) AND (
  (m.id = NEW.id AND (json_extract(m.doc, '$.os') IS NOT json_extract(NEW.doc, '$.os')
    OR json_extract(m.doc, '$.arch') IS NOT json_extract(NEW.doc, '$.arch')
    OR json_extract(m.doc, '$.label') IS NOT json_extract(NEW.doc, '$.label')))
  OR (m.id != NEW.id AND json_extract(m.doc, '$.label') = json_extract(NEW.doc, '$.label'))
  OR (m.project_id = NEW.project_id AND m.id != NEW.id
    AND json_extract(m.doc, '$.herdr_machine') = json_extract(NEW.doc, '$.herdr_machine')))
)
BEGIN SELECT RAISE(ABORT, 'Machine physical identity conflicts with registry'); END;

CREATE TRIGGER machine_identity_update BEFORE UPDATE ON machines
WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id
  OR NEW.id IS NOT json_extract(NEW.doc, '$.id') OR EXISTS (
  SELECT 1 FROM machines m WHERE NOT (m.project_id = OLD.project_id AND m.id = OLD.id) AND (
  (m.id = NEW.id AND (json_extract(m.doc, '$.os') IS NOT json_extract(NEW.doc, '$.os')
    OR json_extract(m.doc, '$.arch') IS NOT json_extract(NEW.doc, '$.arch')
    OR json_extract(m.doc, '$.label') IS NOT json_extract(NEW.doc, '$.label')))
  OR (m.id != NEW.id AND json_extract(m.doc, '$.label') = json_extract(NEW.doc, '$.label'))
  OR (m.project_id = NEW.project_id AND m.id != NEW.id
    AND json_extract(m.doc, '$.herdr_machine') = json_extract(NEW.doc, '$.herdr_machine')))
)
BEGIN SELECT RAISE(ABORT, 'Machine physical identity conflicts with registry'); END;

-- On new databases migration 0017 already installs these from snapshotTables.
CREATE TRIGGER IF NOT EXISTS snapshot_machines_insert AFTER INSERT ON machines BEGIN
  INSERT INTO command_versions VALUES (NEW.project_id, 'machines', 1)
    ON CONFLICT(project_id, collection) DO UPDATE SET version = version + 1;
  INSERT INTO command_rows VALUES (NEW.project_id, 'machines', json_array(NEW.id),
    (SELECT version FROM command_versions WHERE project_id = NEW.project_id AND collection = 'machines'))
    ON CONFLICT(project_id, collection, entity_key) DO UPDATE SET version = excluded.version;
END;
CREATE TRIGGER IF NOT EXISTS snapshot_machines_update AFTER UPDATE ON machines BEGIN
  INSERT INTO command_versions VALUES (NEW.project_id, 'machines', 1)
    ON CONFLICT(project_id, collection) DO UPDATE SET version = version + 1;
  INSERT INTO command_rows VALUES (NEW.project_id, 'machines', json_array(NEW.id),
    (SELECT version FROM command_versions WHERE project_id = NEW.project_id AND collection = 'machines'))
    ON CONFLICT(project_id, collection, entity_key) DO UPDATE SET version = excluded.version;
END;
CREATE TRIGGER IF NOT EXISTS snapshot_machines_delete AFTER DELETE ON machines BEGIN
  INSERT INTO command_versions VALUES (OLD.project_id, 'machines', 1)
    ON CONFLICT(project_id, collection) DO UPDATE SET version = version + 1;
  INSERT INTO command_rows VALUES (OLD.project_id, 'machines', json_array(OLD.id),
    (SELECT version FROM command_versions WHERE project_id = OLD.project_id AND collection = 'machines'))
    ON CONFLICT(project_id, collection, entity_key) DO UPDATE SET version = excluded.version;
END;
