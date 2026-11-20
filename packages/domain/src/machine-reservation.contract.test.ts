import { expect, test } from "vitest";
import {
  holdsStandingOnlyTools,
  isStandingOnlyTool,
  ROLE_TOOL_ALLOWLISTS,
  STANDING_ROLE_TOOLS,
} from "./role.js";

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
