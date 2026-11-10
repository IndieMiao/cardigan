CREATE TABLE card_templates (
  project_id TEXT NOT NULL,
  template_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  doc TEXT NOT NULL,
  PRIMARY KEY (project_id, template_id, version)
);
CREATE TRIGGER card_templates_append_only BEFORE UPDATE ON card_templates
BEGIN SELECT RAISE(ABORT, 'card template versions are immutable'); END;
UPDATE cards SET doc = json_set(doc, '$.template_version', 1)
WHERE json_extract(doc, '$.template_version') IS NULL;
