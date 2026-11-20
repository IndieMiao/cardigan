-- The CLI can compare a candidate directory, not reconstruct it or any launch secret.
CREATE TABLE accepted_browser_path (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  digest TEXT NOT NULL CHECK (length(digest) = 64)
);
