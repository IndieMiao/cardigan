import { expect, onTestFinished, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";

// C-390: an open host maintenance window delivers no bell and starts no Run;
// the queued work goes out once the window reaches a terminal phase.
test("an open maintenance window holds deliveries until it ends", async () => {
  const f = recoveryFixture();
  onTestFinished(f.close);
  vi.mocked(f.runtime.wake).mockResolvedValue({
    ok: true,
    value: { sent: true },
  });
  const phase = (value: string) =>
    f.store.database
      .prepare(`INSERT OR REPLACE INTO host_maintenance
        (singleton, id, phase, record, revision, updated_at)
        VALUES (1, 'M-1', ?, '{}', 1, '2026-11-25T00:00:00.000Z')`)
      .run(value);
  phase("draining");
  f.comment();
  await new Dispatcher(f.options).tick();
  expect(f.runtime.wake).not.toHaveBeenCalled();
  phase("recovery_required");
  await new Dispatcher(f.options).tick();
  expect(f.runtime.wake).not.toHaveBeenCalled();
  phase("completed");
  await new Dispatcher(f.options).tick();
  expect(f.runtime.wake).toHaveBeenCalledTimes(1);
});
