-- M5.S S5: a read cursor can also belong to the project-level event stream.
--
-- `ack_events` mirrors `get_updates`: without a `card_id` it acks the project
-- stream, whose stream key is the empty string (the same key `events.stream`
-- and `router_cursors.stream` use). The old cursors table forced every row
-- through a foreign key into `cards`, which refused that row (it produced a
-- `FOREIGN KEY constraint failed` and the project-level cursor could never move
-- forward). The card-id column keeps its meaning — a card id, or `''` for the
-- project stream — and the assignment foreign key is kept, because a cursor
-- without its Assignment is meaningless.
--
-- The MCP layer still resolves a card argument through `requireCard` before any
-- write, so a cursor for an unknown card is rejected before it reaches here.
CREATE TABLE cursors_stream (
  project_id    TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  -- Card id, or '' for the project-level stream.
  card_id       TEXT NOT NULL,
  acked_seq     INTEGER NOT NULL,
  doc           TEXT NOT NULL,
  PRIMARY KEY (project_id, assignment_id, card_id),
  FOREIGN KEY (project_id, assignment_id)
    REFERENCES assignments (project_id, id)
);

INSERT INTO cursors_stream (project_id, assignment_id, card_id, acked_seq, doc)
  SELECT project_id, assignment_id, card_id, acked_seq, doc FROM cursors;

DROP TABLE cursors;

ALTER TABLE cursors_stream RENAME TO cursors;
