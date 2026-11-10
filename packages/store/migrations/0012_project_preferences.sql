CREATE TABLE project_preferences (
  project_id TEXT NOT NULL REFERENCES projects(id),
  id TEXT NOT NULL CHECK (id = project_id),
  doc TEXT NOT NULL CHECK (json_valid(doc)),
  PRIMARY KEY (project_id, id)
);
