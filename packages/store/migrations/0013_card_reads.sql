-- Card lists need only each card's latest event timestamp, not event bodies.
CREATE INDEX events_by_card_updated_at
  ON events (project_id, card_id, json_extract(doc, '$.created_at'))
  WHERE card_id IS NOT NULL;

-- Card details supplement their own stream with attachment upload facts.
CREATE INDEX events_by_type ON events (project_id, type);
