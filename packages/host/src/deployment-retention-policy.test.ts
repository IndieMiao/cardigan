import type { CommandState } from "@cardigan/domain";
import { expect, test } from "vitest";
import { eligibleRuns, parseRetention } from "./deployment-retention-policy.js";

const now = Date.parse("2026-11-20T12:00:00Z");
test("local released strictly past deadline; all nonterminal Runs, host operations, human references, unknown target and date protect", () => {
  const a = (n: number) => ({
    id: `A-${n}`,
    machine_id: "local",
    status: "released",
    released_at: "2026-11-17T11:59:59Z",
  });
  const state = {
    assignments: [
      a(1),
      { ...a(2), status: "active" },
      { ...a(3), released_at: "2026-11-17T12:00:00Z" },
      a(4),
      a(5),
      a(6),
      a(7),
      { ...a(8), machine_id: "elsewhere" },
      { ...a(9), released_at: undefined },
      { ...a(10), runtime_ref: { target: { fingerprint: "other" } } },
    ],
    runs: [
      { id: "R-1", assignment_id: "A-1", status: "completed" },
      { id: "R-2", assignment_id: "A-4", status: "unknown" },
      { id: "R-7", assignment_id: "A-7", status: "failed" },
    ],
    events: [
      {
        type: "host_ops_action_taken",
        id: "intent",
        payload: { execution: true, assignment_id: "A-5" },
      },
      {
        type: "human_action_requested",
        payload: { human_action_id: "H-1", preparation_run_id: "R-7" },
      },
    ],
    human_actions: [
      {
        id: "H-1",
        status: "open",
        host_assignment_id: "A-6",
        blocked_work_items: [],
      },
    ],
  } as unknown as CommandState;
  expect([...eligibleRuns(state, 3, now, "target").keys()]).toEqual(["A-1"]);
});
test("retention configuration defaults to preview and rejects partially bound authorization", () => {
  expect(parseRetention({})).toEqual({
    revision: 1,
    releases: 5,
    snapshots: 5,
    daily_days: 7,
    released_days: 3,
  });
  for (const policy of [
    { approval: true },
    { approval: { sha256: "a".repeat(64) } },
    { releases: 0 },
    { released_days: "3" },
    { path: "/tmp" },
    null,
  ])
    expect(() => parseRetention(policy)).toThrow();
});
