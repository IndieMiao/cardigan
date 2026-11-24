-- C-674: every project has a 3–4 character display code (`SEN`, `CDG`) that
-- prefixes its numbers outside the project (`SEN-C-34`). Storage keeps the
-- project-scoped numbers; nothing else is rewritten. The code is globally
-- unique and never changes once registered. Existing projects are backfilled
-- by the migration hook (cardigan = CDG, sensen-godot = SEN, others suggested).
ALTER TABLE projects ADD COLUMN code TEXT;
CREATE UNIQUE INDEX projects_code ON projects(code) WHERE code IS NOT NULL;
CREATE TRIGGER projects_code_immutable BEFORE UPDATE OF code ON projects
WHEN OLD.code IS NOT NULL AND NEW.code IS NOT OLD.code
BEGIN
  SELECT RAISE(ABORT, 'project code is immutable');
END;
