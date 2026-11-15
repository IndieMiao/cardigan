import { expect, test } from "vitest";
import { checkLogAttempts } from "./check-log.js";
import type { Event } from "./entities.js";
import { ROLE_TOOL_ALLOWLISTS } from "./role.js";

test("log tool is available to work-item role definitions including PM acceptance", () => {
  expect(ROLE_TOOL_ALLOWLISTS.produce).toContain("get_check_log");
  expect(ROLE_TOOL_ALLOWLISTS.verify).toContain("get_check_log");
  // PM reuses its role for work-item acceptance; live scope is checked by MCP.
  expect(ROLE_TOOL_ALLOWLISTS.standing).toContain("get_check_log");
});

test("attempt discovery accepts only same-card system check events and ignores log_ref", () => {
  const base = {
    card_id: "C-1",
    actor: { kind: "system", project_id: "p" },
    payload: { attempt_id: "attempt-1", status: "queued", log_ref: "/ignored" },
    created_at: "2026-01-01",
  };
  const events = [
    { ...base, seq: 1, type: "merge_check_queued" },
    {
      ...base,
      seq: 2,
      type: "merge_check_finished",
      payload: { ...base.payload, status: "failed" },
    },
    {
      ...base,
      seq: 3,
      type: "precheck_started",
      payload: { attempt_id: "precheck-1", status: "running" },
    },
    {
      ...base,
      seq: 4,
      type: "merge_check_finished",
      actor: { kind: "human" },
      payload: { attempt_id: "forged" },
    },
    {
      ...base,
      seq: 5,
      type: "merge_check_finished",
      card_id: "C-2",
      payload: { attempt_id: "foreign" },
    },
    { ...base, seq: 6, type: "comment", payload: { attempt_id: "guessed" } },
    {
      ...base,
      seq: 7,
      type: "merge_check_finished",
      payload: { attempt_id: "../path" },
    },
  ] as unknown as Event[];
  expect(checkLogAttempts(events, "C-1" as never)).toEqual([
    { attempt_id: "attempt-1", kind: "merge", status: "failed" },
    { attempt_id: "precheck-1", kind: "precheck", status: "running" },
  ]);
});
