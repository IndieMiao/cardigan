import type { Assignment, Event } from "@cardigan/domain";
import { expect, test } from "vitest";
import { overdueStallHandoffs } from "./stall-handoff.js";

const incident = {
  assignment_id: "A-1" as Assignment["id"],
  cause_id: "original",
  system_finished_run_id: "R-1",
};
const at = (ms: number) => new Date(ms).toISOString();
const alert = {
  id: "e1",
  seq: 1,
  type: "dispatch_stall_attention",
  actor: { kind: "system", project_id: "fixture" },
  payload: incident,
  created_at: at(0),
} as Event;

test("only unresolved, unclaimed incidents escalate once, fifteen minutes after handoff", () => {
  const notices = (ms: number, more: Event[] = [], rows = [incident]) =>
    overdueStallHandoffs([alert, ...more], rows, at(ms));
  expect(notices(899_999)).toEqual([]);
  expect(notices(900_000)).toEqual([alert]);
  expect(notices(900_000, [], [])).toEqual([]);
  expect(
    notices(900_000, [], [{ ...incident, system_finished_run_id: "R-2" }]),
  ).toEqual([]);
  expect(
    notices(900_000, [
      {
        ...alert,
        type: "dispatch_stall_handoff_overdue",
        payload: { handoff_id: alert.id },
      },
    ]),
  ).toEqual([]);
  const claimed = {
    ...alert,
    id: "e2" as Event["id"],
    type: "host_ops_action_taken",
    payload: { ...incident, dispatch_stall_id: "original", execution: true },
  };
  expect(notices(900_000, [claimed])).toEqual([]);
  expect(
    notices(900_000, [
      claimed,
      {
        ...alert,
        type: "host_ops_action_finished",
        payload: { action_id: claimed.id, result: "failed" },
      },
    ]),
  ).toEqual([alert]);
});
