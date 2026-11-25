-- C-685: the shared file library every project can see. Contents live only in
-- the private OSS bucket (one immutable object per version); these rows are
-- the directory tree, the version history and who wrote what. Nothing is
-- scoped by project. Removal is a soft delete that keeps the history.
CREATE TABLE shared_dirs (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  parent TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);
CREATE UNIQUE INDEX shared_dirs_live ON shared_dirs (path)
  WHERE deleted_at IS NULL;
CREATE INDEX shared_dirs_parent ON shared_dirs (parent)
  WHERE deleted_at IS NULL;

CREATE TABLE shared_files (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  dir TEXT NOT NULL,
  name TEXT NOT NULL,
  current_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  deleted_by TEXT
);
CREATE UNIQUE INDEX shared_files_live ON shared_files (path)
  WHERE deleted_at IS NULL;
CREATE INDEX shared_files_dir ON shared_files (dir)
  WHERE deleted_at IS NULL;

CREATE TABLE shared_file_versions (
  id TEXT PRIMARY KEY,
  file_id TEXT,
  path TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  sha256 TEXT,
  content_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'committed')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  committed_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE INDEX shared_file_versions_file ON shared_file_versions (file_id);
