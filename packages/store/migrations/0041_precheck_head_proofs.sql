-- A completed executor result is private until the host verifies the producer's HEAD.
-- Neither a restart nor an occupied repository lock may turn it into dispatchable work.
CREATE TABLE precheck_head_proofs (
  project_id TEXT NOT NULL, card_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (project_id, card_id, attempt_id)
);
