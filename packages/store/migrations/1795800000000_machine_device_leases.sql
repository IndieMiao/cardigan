-- C-813: exclusive leases on single external test devices (`<type>:<id>`,
-- capacity 1), across projects. A live row (released_at NULL) holds the
-- device until the system has seen its Run end (and, for adb devices, the
-- Run's own adb slot closed).
CREATE TABLE machine_device_leases (
 generation TEXT PRIMARY KEY,
 machine TEXT NOT NULL,
 type TEXT NOT NULL,
 device TEXT NOT NULL,
 project TEXT NOT NULL,
 assignment_id TEXT NOT NULL,
 run_id TEXT NOT NULL,
 acquired_at TEXT NOT NULL,
 released_at TEXT
);
CREATE UNIQUE INDEX live_device_lease ON machine_device_leases(machine, type, device)
 WHERE released_at IS NULL;
CREATE UNIQUE INDEX live_device_lease_run ON machine_device_leases(project, run_id, type)
 WHERE released_at IS NULL;
CREATE INDEX pending_device_release ON machine_device_leases(project)
 WHERE released_at IS NULL;
