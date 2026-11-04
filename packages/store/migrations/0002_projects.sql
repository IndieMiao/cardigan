-- Projects are not one of the M1.1 entities (ProjectId is a plain string), but
-- `cardigan project create` needs somewhere to record the ids and names the CLI
-- and the server accept. Everything else stores project_id as a plain string.
CREATE TABLE projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
