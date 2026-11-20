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
 project TEXT NOT NULL, run_id TEXT NOT NULL, machine TEXT NOT NULL, reason TEXT NOT NULL, policy_wait INTEGER NOT NULL,
 PRIMARY KEY(project,run_id)
);
CREATE INDEX managed_assignment_history ON machine_resource_leases(project,assignment_id);
