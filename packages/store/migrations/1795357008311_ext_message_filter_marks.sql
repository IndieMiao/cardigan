-- C-580: push filter scopes (kind:<item kind>, project:<id>). A scope switched
-- back on pushes only items whose source event is after its watermark, so
-- nothing filtered while it was off is sent later. 0 = no cutoff.
CREATE TABLE ext_message_filter_marks (
  scope TEXT PRIMARY KEY, enabled INTEGER NOT NULL, watermark INTEGER NOT NULL
);
