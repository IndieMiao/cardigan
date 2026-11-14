-- C-244: change feed for the dispatcher's in-memory candidate index.
-- Same bookkeeping as the command snapshot triggers (0017): one latest
-- revision per row, committed or rolled back with the write itself, so CLI and
-- other-process writes are covered too. Command snapshot versions exclude these
-- two collections, so inbox writes still never invalidate CommandState.

CREATE TRIGGER change_feed_notifications_insert AFTER INSERT ON notifications
BEGIN
  INSERT INTO command_versions VALUES (NEW.project_id, 'notifications', 1)
    ON CONFLICT(project_id, collection) DO UPDATE SET version = version + 1;
  INSERT INTO command_rows VALUES (NEW.project_id, 'notifications', json_array(NEW.id),
    (SELECT version FROM command_versions WHERE project_id = NEW.project_id AND collection = 'notifications'))
    ON CONFLICT(project_id, collection, entity_key) DO UPDATE SET version = excluded.version;
END;

CREATE TRIGGER change_feed_notifications_update AFTER UPDATE ON notifications
BEGIN
  INSERT INTO command_versions VALUES (OLD.project_id, 'notifications', 1)
    ON CONFLICT(project_id, collection) DO UPDATE SET version = version + 1;
  INSERT INTO command_rows VALUES (OLD.project_id, 'notifications', json_array(OLD.id),
    (SELECT version FROM command_versions WHERE project_id = OLD.project_id AND collection = 'notifications'))
    ON CONFLICT(project_id, collection, entity_key) DO UPDATE SET version = excluded.version;
  INSERT INTO command_versions VALUES (NEW.project_id, 'notifications', 1)
    ON CONFLICT(project_id, collection) DO UPDATE SET version = version + 1;
  INSERT INTO command_rows VALUES (NEW.project_id, 'notifications', json_array(NEW.id),
    (SELECT version FROM command_versions WHERE project_id = NEW.project_id AND collection = 'notifications'))
    ON CONFLICT(project_id, collection, entity_key) DO UPDATE SET version = excluded.version;
END;

CREATE TRIGGER change_feed_notifications_delete AFTER DELETE ON notifications
BEGIN
  INSERT INTO command_versions VALUES (OLD.project_id, 'notifications', 1)
    ON CONFLICT(project_id, collection) DO UPDATE SET version = version + 1;
  INSERT INTO command_rows VALUES (OLD.project_id, 'notifications', json_array(OLD.id),
    (SELECT version FROM command_versions WHERE project_id = OLD.project_id AND collection = 'notifications'))
    ON CONFLICT(project_id, collection, entity_key) DO UPDATE SET version = excluded.version;
END;

CREATE TRIGGER change_feed_bell_attempts_insert AFTER INSERT ON bell_attempts
BEGIN
  INSERT INTO command_versions VALUES (NEW.project_id, 'bell_attempts', 1)
    ON CONFLICT(project_id, collection) DO UPDATE SET version = version + 1;
  INSERT INTO command_rows VALUES (NEW.project_id, 'bell_attempts', json_array(NEW.id),
    (SELECT version FROM command_versions WHERE project_id = NEW.project_id AND collection = 'bell_attempts'))
    ON CONFLICT(project_id, collection, entity_key) DO UPDATE SET version = excluded.version;
END;

CREATE TRIGGER change_feed_bell_attempts_update AFTER UPDATE ON bell_attempts
BEGIN
  INSERT INTO command_versions VALUES (OLD.project_id, 'bell_attempts', 1)
    ON CONFLICT(project_id, collection) DO UPDATE SET version = version + 1;
  INSERT INTO command_rows VALUES (OLD.project_id, 'bell_attempts', json_array(OLD.id),
    (SELECT version FROM command_versions WHERE project_id = OLD.project_id AND collection = 'bell_attempts'))
    ON CONFLICT(project_id, collection, entity_key) DO UPDATE SET version = excluded.version;
  INSERT INTO command_versions VALUES (NEW.project_id, 'bell_attempts', 1)
    ON CONFLICT(project_id, collection) DO UPDATE SET version = version + 1;
  INSERT INTO command_rows VALUES (NEW.project_id, 'bell_attempts', json_array(NEW.id),
    (SELECT version FROM command_versions WHERE project_id = NEW.project_id AND collection = 'bell_attempts'))
    ON CONFLICT(project_id, collection, entity_key) DO UPDATE SET version = excluded.version;
END;

CREATE TRIGGER change_feed_bell_attempts_delete AFTER DELETE ON bell_attempts
BEGIN
  INSERT INTO command_versions VALUES (OLD.project_id, 'bell_attempts', 1)
    ON CONFLICT(project_id, collection) DO UPDATE SET version = version + 1;
  INSERT INTO command_rows VALUES (OLD.project_id, 'bell_attempts', json_array(OLD.id),
    (SELECT version FROM command_versions WHERE project_id = OLD.project_id AND collection = 'bell_attempts'))
    ON CONFLICT(project_id, collection, entity_key) DO UPDATE SET version = excluded.version;
END;
