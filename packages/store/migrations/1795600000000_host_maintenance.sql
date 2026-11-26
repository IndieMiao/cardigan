-- C-390: the host's human-only maintenance window (`cardigan maintenance`,
-- `cardigan hc upgrade`). One row at most. While its phase is not terminal,
-- the dispatcher starts no new Run, checks are not admitted and the
-- deployment supervisor does not deploy. `record` is the JSON recovery point:
-- the state before maintenance, the steps taken and what is still to restore.
-- The holder columns name the live CLI process driving a step; a dead holder
-- never blocks the next command.
CREATE TABLE host_maintenance (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  id TEXT NOT NULL,
  phase TEXT NOT NULL,
  record TEXT NOT NULL,
  revision INTEGER NOT NULL,
  holder_pid INTEGER,
  holder_start TEXT,
  holder_machine TEXT,
  updated_at TEXT NOT NULL
);
