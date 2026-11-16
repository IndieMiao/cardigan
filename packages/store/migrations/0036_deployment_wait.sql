-- Execution target and observer machine are distinct (SSH/GitHub own host clients).
-- Legacy rows retain NULL; only same-boot evidence can establish local ownership.
ALTER TABLE merge_check_capacity ADD COLUMN owner_machine TEXT;
CREATE TABLE host_deployment_waiter (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_pid INTEGER NOT NULL,
  owner_start TEXT NOT NULL,
  owner_machine TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('waiting', 'held'))
);

-- Keep host_deployment_capacity at three columns: the previous supervisor
-- remains alive across server upgrades and uses INSERT ... VALUES without a column list.
