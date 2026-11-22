-- Fixed action/field names and public outcomes only. A reserved test is never resent.
CREATE TABLE feishu_settings_requests (
  request_key TEXT PRIMARY KEY, subject TEXT NOT NULL, actor TEXT NOT NULL,
  keys TEXT NOT NULL, result TEXT NOT NULL, at TEXT NOT NULL
);
