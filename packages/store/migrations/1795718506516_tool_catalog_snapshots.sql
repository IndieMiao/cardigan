-- C-797: the tool structure behind each recorded tool catalog fingerprint, so
-- a later deploy can tell "only new optional parameters" from an incompatible
-- change. Content-addressed and shared by every project; `structure` is the
-- gzip of the canonical JSON whose sha256 is `fingerprint`.
CREATE TABLE tool_catalog_snapshots (
  fingerprint TEXT PRIMARY KEY,
  structure BLOB NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX tool_catalog_snapshots_recorded_at
  ON tool_catalog_snapshots (recorded_at);
