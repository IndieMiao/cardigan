-- C-833: the adb environment a session was launched with (whether the
-- machine handed out adb slots, and which adb device types it handed out).
-- A live session whose launch environment differs from the machine's current
-- one is replaced at its next wake, so it picks up its slot port and
-- ADB_USB=0. One row per launched Run; no ports are stored.
CREATE TABLE machine_adb_launches (
 project TEXT NOT NULL,
 run_id TEXT NOT NULL,
 machine TEXT NOT NULL,
 environment TEXT NOT NULL,
 launched_at TEXT NOT NULL,
 PRIMARY KEY (project, run_id)
);
