import { expect, test } from "vitest";
import { m5Cross, TEST_PASSWORD } from "../test-support/m5-cross.js";
import { runtimeEvents } from "../test-support/runtime-events.js";
import { RuntimeMonitor } from "./dispatch-monitor.js";

test("M5.6 Web and MCP Needs You expose runtime loss, its timestamp and last Run from the monitor", async () => {
  const f = await m5Cross(),
    events = runtimeEvents();
  let at = Date.now();
  const clock = { now: () => new Date(at).toISOString() };
  const monitor = new RuntimeMonitor({
    store: f.store(),
    runtime: events.source,
    clock,
    lossGraceMs: 10,
  });
  try {
    await f.start(f.primary.owner);
    const old = f.current(f.primary.owner),
      run = f.state().runs.find((r) => r.assignment_id === old.id);
    if (!old.runtime_ref) throw new Error("No runtime reference");
    monitor.reconcile();
    events.send({
      seq: 1,
      type: "lost",
      terminal_ref: old.runtime_ref.terminal_ref,
    });
    await expect.poll(() => f.current(old).runtime_state).toBe("unknown");
    const disconnected_at = clock.now();
    at += 11;
    monitor.reconcile();
    expect(f.current(old).runtime_state).toBe("lost");
    await f.password(TEST_PASSWORD);
    await f.login();
    const web = await f.call(f.projectPath("/needs-you"));
    expect(web.status).toBe(200);
    const office = f
      .state()
      .assignments.find(
        (a) => a.scope === "standing" && a.standing_mode === "office",
      );
    if (!office) throw new Error("No PM Office");
    await f.start(office);
    const before = f.state().cursors;
    const mcp = await f.mcp(office, "list_needs_you", {});
    for (const response of [web.json, mcp])
      expect(response).toMatchObject({
        incidents: [
          {
            id: old.id,
            runtime_state: "lost",
            disconnected_at,
            lost_at: clock.now(),
            last_run: { id: run?.id, status: "unknown" },
          },
        ],
      });
    expect(f.state().cursors).toEqual(before);
  } finally {
    await monitor.stop();
    await f.close();
  }
});
