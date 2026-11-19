-- The comparison key stays in the private host database, never in a Run.
CREATE TABLE launch_comparison_key (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  key BLOB NOT NULL CHECK (length(key) = 32)
);
INSERT INTO launch_comparison_key VALUES (1, randomblob(32));

-- Intent only: never store launch.yaml, credentials or request bodies here.
CREATE TABLE launch_model_intents (
  path TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  before_hash TEXT NOT NULL,
  after_hash TEXT NOT NULL,
  notice TEXT NOT NULL
);
