-- C-844: emulator processes the adb sweep found on a worker under a
-- project's account that no Run's emulator slot covers (started by a Run
-- without an emulator lease, or by hand). Holds the latest observation per
-- project and machine; rows of processes no longer seen are removed. The
-- console port and PID stay in host diagnostics, never in events.
CREATE TABLE machine_unregistered_emulators (
 project TEXT NOT NULL,
 machine TEXT NOT NULL,
 pid INTEGER NOT NULL,
 started TEXT NOT NULL,
 kind TEXT NOT NULL,
 port INTEGER,
 assignment_id TEXT,
 run_id TEXT,
 first_seen_at TEXT NOT NULL,
 last_seen_at TEXT NOT NULL,
 stop_reason TEXT,
 stop_failed_at TEXT,
 PRIMARY KEY (project, machine, pid, started)
);
