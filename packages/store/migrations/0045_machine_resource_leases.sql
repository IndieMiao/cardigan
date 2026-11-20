-- Calendar windows and physical holds have independent end conditions.
CREATE TABLE machine_resource_leases (
 generation TEXT PRIMARY KEY, machine TEXT NOT NULL, resource TEXT NOT NULL,
 project TEXT NOT NULL, assignment_id TEXT, run_id TEXT, starts_at TEXT NOT NULL,
 ends_at TEXT, deadline_recorded TEXT, binding TEXT, target TEXT,
 endpoints TEXT NOT NULL, release_state TEXT, verified_at TEXT,
 CHECK ((ends_at IS NULL) = (run_id IS NOT NULL)),
 CHECK (binding IS NOT NULL OR ends_at IS NOT NULL)
);
CREATE UNIQUE INDEX single_resource_holder ON machine_resource_leases(machine, resource)
 WHERE run_id IS NOT NULL AND verified_at IS NULL;
CREATE INDEX live_resource_calendar ON machine_resource_leases(machine, resource, ends_at);
CREATE INDEX pending_resource_probe ON machine_resource_leases(project) WHERE verified_at IS NULL;
CREATE TABLE machine_resource_waits (
 project TEXT NOT NULL, run_id TEXT NOT NULL, machine TEXT NOT NULL, reason TEXT NOT NULL, policy_wait INTEGER NOT NULL, publication_wait INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(project,run_id)
);
CREATE INDEX managed_assignment_history ON machine_resource_leases(project,assignment_id);

-- Empty after upgrade: absence is NOT evidence of a safe first handoff.
CREATE TABLE machine_binding_clearances (
 machine TEXT NOT NULL, resource TEXT NOT NULL, project TEXT NOT NULL, binding TEXT NOT NULL, target TEXT NOT NULL,
 generation TEXT NOT NULL UNIQUE, verified_at TEXT,
 PRIMARY KEY(machine,resource,project,binding,target)
);
-- If an unbound launcher claims this resource again (including an older host
-- during rollout), retire both cached proofs and in-flight challenges.
CREATE TRIGGER invalidate_binding_clearance AFTER INSERT ON bell_attempts
WHEN EXISTS (SELECT 1 FROM machine_binding_clearances)
BEGIN
 DELETE FROM machine_binding_clearances WHERE machine=(SELECT machine_id FROM assignments WHERE project_id=NEW.project_id AND id=NEW.assignment_id)
   AND EXISTS (SELECT 1 FROM runs r WHERE r.project_id=NEW.project_id AND r.id=NEW.run_id AND
     (json_type(r.doc,'$.resource_keys') IS NULL OR resource IN (SELECT value FROM json_each(r.doc,'$.resource_keys'))))
   AND NOT EXISTS (SELECT 1 FROM machine_resource_leases l WHERE l.project=NEW.project_id AND l.run_id=NEW.run_id AND l.resource=machine_binding_clearances.resource AND l.verified_at IS NULL);
END;

-- Pin the preflight target for deferred delivery and process restarts, even
-- for check-only resources that do not have a physical lease.
CREATE TABLE machine_run_probe_targets (
 project TEXT NOT NULL, run_id TEXT NOT NULL, target TEXT NOT NULL, policy TEXT NOT NULL,
 PRIMARY KEY(project,run_id)
);
