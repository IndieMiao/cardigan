-- Read-only Workbench selectors. Canonical JSON and old readers remain compatible.
CREATE INDEX events_by_time
  ON events (project_id, json_extract(doc, '$.created_at') DESC, id DESC);
CREATE INDEX events_by_card_time
  ON events (project_id, card_id, json_extract(doc, '$.created_at') DESC, id DESC);
CREATE INDEX events_by_decision
  ON events (project_id, json_extract(doc, '$.payload.decision_id'), type);
CREATE INDEX cards_by_status
  ON cards (project_id, json_extract(doc, '$.status'), id) WHERE json_extract(doc, '$.status') IS NOT NULL;
CREATE INDEX work_items_by_card ON work_items (project_id, card_id);
CREATE INDEX assignments_by_status
  ON assignments (project_id, json_extract(doc, '$.status'), id) WHERE json_extract(doc, '$.status') IS NOT NULL;
CREATE INDEX assignments_by_work_item
  ON assignments (project_id, json_extract(doc, '$.work_item_id')) WHERE json_extract(doc, '$.work_item_id') IS NOT NULL;
CREATE INDEX runs_by_assignment_number
  ON runs (project_id, assignment_id, CAST(substr(id, 3) AS INTEGER) DESC) WHERE json_extract(doc, '$.status') IS NOT NULL;
CREATE INDEX runs_by_status
  ON runs (project_id, json_extract(doc, '$.status'), id) WHERE json_extract(doc, '$.status') IS NOT NULL;
CREATE INDEX deliveries_by_work_item ON deliveries (project_id, work_item_id);
CREATE INDEX reviews_by_delivery ON reviews (project_id, delivery_id);
CREATE INDEX decisions_by_resolution
  ON decisions (project_id, json_extract(doc, '$.resolution.at') DESC, id DESC) WHERE json_extract(doc, '$.resolution.at') IS NOT NULL;
CREATE INDEX decisions_by_status
  ON decisions (project_id, json_extract(doc, '$.status'), id) WHERE json_extract(doc, '$.status') IS NOT NULL;
CREATE INDEX decisions_by_card
  ON decisions (project_id, json_extract(doc, '$.card_id')) WHERE json_extract(doc, '$.card_id') IS NOT NULL;
CREATE INDEX human_actions_by_status
  ON human_actions (project_id, json_extract(doc, '$.status'), id) WHERE json_extract(doc, '$.status') IS NOT NULL;
CREATE INDEX attachments_by_card
  ON attachments (project_id, json_extract(doc, '$.card_id')) WHERE json_extract(doc, '$.card_id') IS NOT NULL;
CREATE INDEX runs_by_number ON runs (project_id, CAST(substr(id, 3) AS INTEGER) DESC) WHERE json_extract(doc, '$.status') IS NOT NULL;
CREATE INDEX events_by_run ON events (project_id, type, json_extract(doc, '$.payload.run_id'));
CREATE INDEX timeline_by_decision ON timeline (project_id, json_extract(doc, '$.decision_id')) WHERE json_extract(doc, '$.decision_id') IS NOT NULL;
CREATE INDEX timeline_by_action ON timeline (project_id, json_extract(doc, '$.human_action_id')) WHERE json_extract(doc, '$.human_action_id') IS NOT NULL;
CREATE INDEX timeline_by_type_time ON timeline (project_id, json_extract(doc, '$.type'), json_extract(doc, '$.created_at')) WHERE json_extract(doc, '$.type') = 'comment';
CREATE INDEX runs_queue_candidates ON runs (project_id, id) WHERE json_extract(doc, '$.status') = 'queued' AND json_extract(doc, '$.queue_reason') = 'concurrency_limit';
CREATE INDEX events_by_attachment ON events (project_id, json_extract(doc, '$.payload.attachment_id'), type);
