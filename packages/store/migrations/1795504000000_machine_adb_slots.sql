-- C-679: per-Run adb server / emulator port slots on a machine, across
-- projects. A live row (released_at NULL) holds its slot and ports until the
-- system has closed them on the worker; sweep rows briefly hold a free slot
-- while it is checked for orphans.
CREATE TABLE machine_adb_slots (
 generation TEXT PRIMARY KEY,
 machine TEXT NOT NULL,
 slot INTEGER NOT NULL,
 adb_port INTEGER NOT NULL,
 emulator_port INTEGER,
 project TEXT NOT NULL,
 assignment_id TEXT,
 run_id TEXT,
 purpose TEXT NOT NULL CHECK (purpose IN ('run', 'sweep')),
 emulator INTEGER NOT NULL DEFAULT 0,
 target TEXT,
 acquired_at TEXT NOT NULL,
 release_state TEXT,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TEXT,
 released_at TEXT,
 CHECK ((purpose = 'run') = (run_id IS NOT NULL))
);
CREATE UNIQUE INDEX live_adb_slot ON machine_adb_slots(machine, slot)
 WHERE released_at IS NULL;
CREATE UNIQUE INDEX live_adb_port ON machine_adb_slots(machine, adb_port)
 WHERE released_at IS NULL;
CREATE UNIQUE INDEX live_adb_emulator_port ON machine_adb_slots(machine, emulator_port)
 WHERE released_at IS NULL AND emulator_port IS NOT NULL;
CREATE UNIQUE INDEX live_adb_run ON machine_adb_slots(project, run_id)
 WHERE released_at IS NULL AND run_id IS NOT NULL;
CREATE INDEX pending_adb_release ON machine_adb_slots(project)
 WHERE released_at IS NULL;
