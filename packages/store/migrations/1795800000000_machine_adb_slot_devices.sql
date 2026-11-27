-- C-813: a Run's adb slot may also hold one USB Android device (its serial).
-- The device stays held until the slot is released, i.e. until the Run's own
-- adb server has been closed and the device is free for another server.
ALTER TABLE machine_adb_slots ADD COLUMN device TEXT;
CREATE UNIQUE INDEX live_adb_device ON machine_adb_slots(machine, device)
 WHERE released_at IS NULL AND device IS NOT NULL;
