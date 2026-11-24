import { expect, test } from "vitest";
import { exitedAgentRow } from "./stall-patrol.js";

// C-690: a proven exited Agent is recovered by the guarded release whatever
// retirement state held its row (handoff of another session, unconfirmed
// retirement exit or the maintenance fence); every other block is kept.
test("only maintenance and retirement fences yield to a proven exited Agent", () => {
  for (const fence of [
    "session_maintenance",
    "retirement_handoff_changed",
    "retirement_exit_unconfirmed",
  ]) {
    expect(
      exitedAgentRow({ restart_blocked: fence }, { agent_exited: true }),
    ).toBe(true);
    expect(
      exitedAgentRow({ restart_blocked: fence }, { agent_exited: false }),
    ).toBe(false);
  }
  for (const kept of [
    null,
    "human_stopped",
    "unfinished_run",
    "shared_registration",
    "card_held",
    "work_item_wait",
  ])
    expect(
      exitedAgentRow({ restart_blocked: kept }, { agent_exited: true }),
    ).toBe(false);
});
