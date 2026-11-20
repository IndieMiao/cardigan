import { expect, test } from "vitest";
import { run } from "./commands/test-fixtures.js";
import {
  holdsStandingOnlyTools,
  isStandingOnlyTool,
  ROLE_TOOL_ALLOWLISTS,
  STANDING_ROLE_TOOLS,
} from "./role.js";
import { awaitsStartPublication } from "./run-capacity.js";

test("the resource reservation grant is standing-PM only, not a power on work-item or host-ops tokens", () => {
  const tool = "reserve_machine_resource";
  expect(STANDING_ROLE_TOOLS).toContain(tool);
  expect(isStandingOnlyTool(tool)).toBe(true);
  expect(ROLE_TOOL_ALLOWLISTS.produce).not.toContain(tool);
  expect(ROLE_TOOL_ALLOWLISTS.verify).not.toContain(tool);
  expect(holdsStandingOnlyTools({ role_id: "pm", scope: "work_item" })).toBe(
    false,
  );
  expect(
    holdsStandingOnlyTools({ role_id: "host_ops", scope: "standing" }),
  ).toBe(false);
});

test("only an unstarted queued or dispatched Run can use a resource publication grant", () => {
  const r = run();
  for (const status of ["queued", "dispatched"] as const) {
    expect(awaitsStartPublication({ ...r, status })).toBe(true);
    expect(
      awaitsStartPublication({
        ...r,
        status,
        started_at: "2032-03-01T10:00:00Z",
      }),
    ).toBe(false);
  }
  for (const status of [
    "acked",
    "running",
    "completed",
    "failed",
    "cancelled",
    "unknown",
  ] as const)
    expect(awaitsStartPublication({ ...r, status })).toBe(false);
});
