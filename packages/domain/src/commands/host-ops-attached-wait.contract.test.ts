import { expect, test } from "vitest";
import type { Actor, Assignment } from "../entities.js";
import { HOST_OPS_ROLE_TOOLS, hostOpsPending } from "../host-ops.js";
import type { CommandState } from "./core.js";
import {
  beginHostOpsAction,
  claimHostOpsAction,
  finishHostOpsAction,
  hostOpsReadDiagnostics,
} from "./host-ops-actions.js";
import {
  ATTACHED_HUMAN_WAIT_OVERDUE,
  ATTACHED_HUMAN_WAIT_REASON,
  hostOpsActionWaitStatus,
  recordAttachedHumanWait,
} from "./host-ops-attached-wait.js";
import { notices } from "./notices.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  id,
  now,
  ports,
  role,
  value,
} from "./test-fixtures.js";

const { work_item_id: _work, ...opsFields } = assignment(10, "host_ops");
const ops: Assignment = { ...opsFields, scope: "standing" };
const caller = {
  ...actor(10, "host_ops"),
  allowed_tools: HOST_OPS_ROLE_TOOLS,
} as Extract<Actor, { kind: "assignment" }>;
const system: Actor = { kind: "system", project_id: "p1" as never };
const io = ports();
const at = (ms: number) => ({
  ...io,
  clock: { now: () => new Date(Date.parse(now) + ms).toISOString() },
});

function pending() {
  const s = fixture();
  const state: CommandState = {
    ...s,
    roles: [
      ...s.roles,
      { ...role("host_ops"), allowed_tools: HOST_OPS_ROLE_TOOLS },
    ],
    assignments: [...s.assignments, ops],
  };
  const begun = value(
    beginHostOpsAction(
      state,
      caller,
      {
        tool: "host_ops_restart_standing_pm",
        target_id: id("assignment", 4),
        reason: "Context at restart threshold",
        snapshot: { model: "test", agent_cli_version: "test" },
      },
      io,
    ),
  );
  return {
    state: apply(state, begun),
    action_id: begun.data.action_id,
    actor: { ...system, project_id: state.project_id } as Actor,
  };
}
const attached = { mode: "interactive" as const, started_at: now };

test("C-678: the wait names its reason and connection start; diagnostics show it instead of pending", () => {
  const { state, action_id, actor: sys } = pending();
  expect(hostOpsActionWaitStatus(state.events, action_id)).toEqual({
    status_reason: "pending",
  });
  const effect = value(
    recordAttachedHumanWait(state, sys, { action_id, attached }, at(1_000)),
  );
  expect(effect.changes).toEqual([]);
  expect(effect.data.overdue).toBeUndefined();
  expect(effect.events).toHaveLength(1);
  expect(effect.events[0]).toMatchObject({
    type: "host_ops_action_deferred",
    payload: {
      action_id,
      assignment_id: id("assignment", 4),
      reason: ATTACHED_HUMAN_WAIT_REASON,
      attach_mode: "interactive",
      attached_since: now,
      tool: "host_ops_restart_standing_pm",
      requested_by: `${caller.assignment_id}（主机运维）`,
    },
  });
  const waiting = apply(state, effect);
  const diagnostics = value(hostOpsReadDiagnostics(waiting, caller)).data;
  expect(diagnostics.actions).toEqual([
    expect.objectContaining({
      action_id,
      status_reason: ATTACHED_HUMAN_WAIT_REASON,
      attached_since: now,
      attach_mode: "interactive",
      waiting_since: effect.events[0]?.created_at,
    }),
  ]);
  // The wait only reports; the action stays pending and fenced.
  expect(hostOpsPending(waiting.events, id("assignment", 4))).toBe(true);
  // The same attach session is recorded once.
  expect(
    value(
      recordAttachedHumanWait(waiting, sys, { action_id, attached }, at(2_000)),
    ).events,
  ).toEqual([]);
});

test("C-678: one Needs You notice per action once the wait passes the threshold", () => {
  const { state, action_id, actor: sys } = pending();
  const first = apply(
    state,
    value(recordAttachedHumanWait(state, sys, { action_id, attached }, at(0))),
  );
  expect(
    value(
      recordAttachedHumanWait(
        first,
        sys,
        { action_id, attached },
        at(10 * 60_000 - 1),
      ),
    ).events,
  ).toEqual([]);
  const late = value(
    recordAttachedHumanWait(
      first,
      sys,
      { action_id, attached },
      at(10 * 60_000),
    ),
  );
  expect(late.events.map((e) => e.type)).toEqual([ATTACHED_HUMAN_WAIT_OVERDUE]);
  const notified = apply(first, late);
  expect(notices(notified)[0]).toMatchObject({
    id: late.events[0]?.id,
    resolved_by: "system",
    read: false,
  });
  expect(notices(notified)[0]?.body).toContain("已等待 10 分钟");
  // A later attach session adds its own wait fact but never a second notice.
  const again = value(
    recordAttachedHumanWait(
      notified,
      sys,
      {
        action_id,
        attached: { mode: "observe", started_at: at(11 * 60_000).clock.now() },
      },
      at(20 * 60_000),
    ),
  );
  expect(again.events.map((e) => e.type)).toEqual(["host_ops_action_deferred"]);
  // A configured threshold is honoured.
  expect(
    value(
      recordAttachedHumanWait(
        first,
        sys,
        { action_id, attached, notice_after_ms: 60_000 },
        at(60_000),
      ),
    ).events.map((e) => e.type),
  ).toEqual([ATTACHED_HUMAN_WAIT_OVERDUE]);
});

test("C-678: a claim after the wait clears the stale reason; finished actions record nothing", () => {
  const { state, action_id, actor: sys } = pending();
  const waiting = apply(
    state,
    value(recordAttachedHumanWait(state, sys, { action_id, attached }, at(0))),
  );
  const claimed = apply(
    waiting,
    value(claimHostOpsAction(waiting, sys, action_id, at(1_000))),
  );
  expect(hostOpsActionWaitStatus(claimed.events, action_id)).toEqual({
    status_reason: "pending",
  });
  const finished = apply(
    claimed,
    value(finishHostOpsAction(claimed, sys, action_id, at(2_000))),
  );
  const none = value(
    recordAttachedHumanWait(finished, sys, { action_id, attached }, at(3_000)),
  );
  expect(none.events).toEqual([]);
  expect(none.data).toEqual({ waiting: undefined, overdue: undefined });
});

test("C-678: only the system records waits", () => {
  const { state, action_id } = pending();
  expect(
    recordAttachedHumanWait(state, caller, { action_id, attached }, io).ok,
  ).toBe(false);
});
