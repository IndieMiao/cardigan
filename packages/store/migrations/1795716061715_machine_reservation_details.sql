-- C-800: who made a calendar reservation, when a human cancelled it, and why
-- a Run waits (reservation vs concurrency), so a blocked project can see the
-- holder's metadata and a cancel can wake exactly the Runs it held back.
ALTER TABLE machine_resource_leases ADD COLUMN source TEXT;
ALTER TABLE machine_resource_leases ADD COLUMN cancelled_at TEXT;
UPDATE machine_resource_leases SET source = (
  SELECT CASE json_extract(e.doc, '$.actor.kind')
    WHEN 'human' THEN 'human'
    WHEN 'assignment' THEN 'standing_pm'
  END
  FROM events e
  WHERE e.project_id = machine_resource_leases.project
    AND e.type = 'machine_resource_reserved'
    AND json_extract(e.doc, '$.payload.generation') = machine_resource_leases.generation
  LIMIT 1
) WHERE run_id IS NULL;
ALTER TABLE machine_resource_waits ADD COLUMN kind TEXT NOT NULL DEFAULT 'capacity';
ALTER TABLE machine_resource_waits ADD COLUMN reservation TEXT;
UPDATE machine_resource_waits SET kind = CASE
  WHEN reason LIKE '%预约独占%' THEN 'reservation'
  WHEN policy_wait = 1 THEN 'resource'
  ELSE 'capacity'
END;
CREATE INDEX machine_resource_waits_by_reservation
  ON machine_resource_waits (reservation) WHERE reservation IS NOT NULL;
