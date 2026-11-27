-- C-817: external test devices a person has seen, enabled or disabled, and
-- the projects each may be handed to. Across projects, like the C-813
-- leases: one row per physical device on a machine. A device is dispatchable
-- only while `status = 'enabled'` and the Run's project is in `projects`.
-- Leases are never changed here.
CREATE TABLE machine_devices (
 machine TEXT NOT NULL,
 type TEXT NOT NULL,
 device TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('pending','initializing','failed','enabled','disabled')),
 projects TEXT NOT NULL DEFAULT '[]',
 model TEXT,
 version TEXT,
 resolution TEXT,
 init_project TEXT,
 -- Set while one machine check runs the initialization (a claim).
 init_started_at TEXT,
 failure TEXT,
 discovered_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 initialized_at TEXT,
 PRIMARY KEY (machine, type, device)
);
