-- Fixed action/field names and public outcomes only. A reserved test is never resent.
CREATE TABLE feishu_settings_requests (
  request_key TEXT PRIMARY KEY, subject TEXT NOT NULL, actor TEXT NOT NULL,
  keys TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL
);

-- Only a digest of app/tenant identifies the binding budget; a new worker reuses it.
CREATE TABLE feishu_binding_windows (
  scope TEXT PRIMARY KEY, start INTEGER NOT NULL, tries INTEGER NOT NULL
);

-- One fenced publication per configuration. No raw path, setting or credential.
CREATE TABLE feishu_settings_publications (
  scope TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE REFERENCES feishu_settings_requests(request_key),
  original TEXT NOT NULL, publication TEXT NOT NULL UNIQUE, watermark INTEGER NOT NULL,
  fingerprints TEXT -- channel/digest pairs; NULL once activation has consumed the cutoff
);
