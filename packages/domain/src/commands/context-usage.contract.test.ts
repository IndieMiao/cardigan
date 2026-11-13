import { expect, test } from "vitest";
import {
  type ContextObservation,
  contextUsageLevel,
} from "../context-usage.js";
import type { Actor, Assignment } from "../entities.js";
import { HOST_OPS_ROLE_TOOLS } from "../host-ops.js";
import { contextUsageThresholds } from "../preferences.js";
import { recordContextUsageNotices } from "./context-usage.js";
import type { CommandState } from "./core.js";
import { beginHostOpsAction, finishHostOpsAction } from "./host-ops-actions.js";
import { projectPreferences, setProjectPreferences } from "./preferences.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  now,
  ports,
  role,
  value,
} from "./test-fixtures.js";

const { work_item_id: _work, ...fields } = assignment(10, "host_ops");
const ops: Assignment = { ...fields, scope: "standing" };
const caller = {
  ...actor(10, "host_ops"),
  allowed_tools: HOST_OPS_ROLE_TOOLS,
} as Actor;
const system = { kind: "system", project_id: human.project_id } as const;
const base = (): CommandState => {
  const s = fixture();
  return {
    ...s,
    assignments: [...s.assignments, ops],
    roles: [
      ...s.roles,
      { ...role("host_ops"), allowed_tools: HOST_OPS_ROLE_TOOLS },
    ],
  };
};
function usage(pct = 80): ContextObservation {
  const a = base().assignments[0];
  if (!a) throw new Error("Missing fixture assignment");
  return {
    assignment_id: a.id,
    runtime_key: JSON.stringify(a.runtime_ref),
    agent: "codex",
    session_id: "fixture-session",
    cwd: "/fixture",
    transcript_path: null,
    model: "fixture",
    context_tokens: pct * 1000,
    context_window_size: 100000,
    used_percentage: pct,
    updated_at: now,
    source: "codex_rollout:last_token_usage",
  };
}
const notices = (s = base(), u = usage()) =>
  recordContextUsageNotices(s, system, u, 60_000, ports());

test("remaining percentages default to 20/15, update atomically with audit, and remain human-only", () => {
  let s = base();
  expect(contextUsageThresholds(projectPreferences(s))).toEqual({
    handoff: 20,
    restart: 15,
  });
  for (const input of [
    { context_restart_remaining_pct: 20 },
    { context_handoff_remaining_pct: 15 },
    { context_handoff_remaining_pct: NaN },
    { context_handoff_remaining_pct: null as unknown as number },
    { context_restart_remaining_pct: null as unknown as number },
    { context_restart_remaining_pct: 0 },
    { context_handoff_remaining_pct: 100 },
  ]) {
    expect(setProjectPreferences(s, human, input, ports()).ok).toBe(false);
  }
  expect(
    setProjectPreferences(
      s,
      caller,
      { context_handoff_remaining_pct: 25 },
      ports(),
    ).ok,
  ).toBe(false);
  const change = value(
    setProjectPreferences(
      s,
      human,
      { context_handoff_remaining_pct: 30, context_restart_remaining_pct: 25 },
      ports(),
    ),
  );
  s = apply(s, change);
  expect(change.events.map((e) => e.payload)).toEqual(
    expect.arrayContaining([
      {
        preference: "context_handoff_remaining_pct",
        old_value: 20,
        new_value: 30,
      },
      {
        preference: "context_restart_remaining_pct",
        old_value: 15,
        new_value: 25,
      },
    ]),
  );
  expect(
    value(
      setProjectPreferences(
        s,
        human,
        { context_restart_remaining_pct: 25 },
        ports(),
      ),
    ).events,
  ).toHaveLength(0);
  expect(contextUsageLevel(usage(74.9), projectPreferences(s))).toBe("handoff");
  expect(contextUsageLevel(usage(75), projectPreferences(s))).toBe("restart");
});

test("threshold boundaries are inclusive and notices persist once per session and level", () => {
  let s = base();
  expect(
    contextUsageLevel(usage(80.1), {
      id: s.project_id,
      auto_merge_after_minutes: null,
      context_handoff_remaining_pct: 19.9,
    }),
  ).toBe("handoff");
  expect(value(notices(s, usage(79.9))).data).toHaveLength(0);
  const first = value(notices(s));
  expect(first.data).toHaveLength(1);
  expect(first.data[0]?.recipient).toBe(usage().assignment_id);
  expect(first.events[0]?.payload).toMatchObject({
    level: "handoff",
    remaining_percentage: 20,
    action: "update_handoff",
    result: "queued",
  });
  expect(first.timeline).toHaveLength(1);
  s = apply(s, first);
  expect(value(notices(s)).events).toHaveLength(0);
  const second = value(notices(s, usage(85)));
  expect(second.data).toHaveLength(1);
  expect(second.data[0]?.recipient).toBe(ops.id);
  expect(second.events[0]?.payload).toMatchObject({
    level: "restart",
    remaining_percentage: 15,
  });
  s = apply(s, second);
  expect(value(notices(s, usage(99))).events).toHaveLength(0);
  expect(
    value(
      notices(
        {
          ...s,
          assignments: s.assignments.map((a) =>
            a.id === usage().assignment_id
              ? { ...a, session_ref: "new-session" }
              : a,
          ),
        },
        { ...usage(85), session_id: "new-session" },
      ),
    ).events,
  ).toHaveLength(1);
});

test("C-211 crossing both thresholds in one round sends only the handoff; the restart follows next round", () => {
  let s = base();
  const jump = value(notices(s, usage(86)));
  expect(
    jump.events.map((e) => (e.payload as { level: string }).level),
  ).toEqual(["handoff"]);
  expect(jump.data.map((v) => v.recipient)).toEqual([usage().assignment_id]);
  s = apply(s, jump);
  const next = value(notices(s, usage(86)));
  expect(
    next.events.map((e) => (e.payload as { level: string }).level),
  ).toEqual(["restart"]);
  expect(next.data.map((v) => v.recipient)).toEqual([ops.id]);
  s = apply(s, next);
  expect(value(notices(s, usage(90))).events).toHaveLength(0);
});

test("stale, future, replaced and inactive observations cannot trigger actions; Agent cannot forge patrol", () => {
  const s = base();
  for (const u of [
    { ...usage(), updated_at: "2000-01-01T00:00:00Z" },
    { ...usage(), updated_at: "2099-01-01T00:00:00Z" },
    { ...usage(), runtime_key: "old-runtime" },
    { ...usage(), context_window_size: 0 },
  ])
    expect(value(notices(s, u)).events).toHaveLength(0);
  expect(
    value(
      notices({
        ...s,
        assignments: s.assignments.map((a) =>
          a.id === usage().assignment_id
            ? { ...a, status: "released" as const }
            : a,
        ),
      }),
    ).events,
  ).toHaveLength(0);
  expect(recordContextUsageNotices(s, caller, usage(), 60000, ports()).ok).toBe(
    false,
  );
});

test("external Office gets handoff inbox and one manual clear request without a restart intent", () => {
  const s = base();
  const office = s.assignments.find(
    (a) => a.scope === "standing" && a.role_id === "pm",
  );
  if (!office) throw new Error("Missing fixture Office");
  const external: Assignment = { ...office, external: true };
  const state = {
    ...s,
    assignments: s.assignments.map((a) => (a.id === office.id ? external : a)),
  };
  const u = {
    ...usage(85),
    assignment_id: office.id,
    runtime_key: JSON.stringify(office.runtime_ref),
  };
  const handoff = value(notices(state, u));
  expect(handoff.data.map((v) => v.recipient)).toEqual([office.id]);
  const handedOff = apply(state, handoff);
  // C-211: the manual clear request follows on the next round.
  const result = value(notices(handedOff, u));
  expect(result.data.map((v) => v.recipient)).toEqual([office.id]);
  const next = apply(handedOff, result);
  expect(next.human_actions.at(-1)).toMatchObject({
    triage: "human",
    instructions: expect.stringContaining("/clear"),
    blocked_work_items: [],
  });
  expect(value(notices(next, u)).events).toHaveLength(0);
  expect(next.events.some((e) => e.type === "host_ops_action_taken")).toBe(
    false,
  );
});

test("context restart binds current session, rechecks preferences, clears resume ID, and deduplicates beyond idempotency keys", () => {
  let s = base();
  const u = usage(85);
  s = {
    ...s,
    assignments: s.assignments.map((a) =>
      a.id === u.assignment_id ? { ...a, session_ref: u.session_id } : a,
    ),
  };
  const params = {
    tool: "host_ops_restart_assignment" as const,
    target_id: u.assignment_id,
    reason: "Context exhausted",
    context_usage: u,
    context_stale_after_ms: 60000,
    snapshot: { model: "test", agent_cli_version: "test" },
  };
  expect(
    beginHostOpsAction(
      s,
      caller,
      { ...params, context_usage: usage(84.9) },
      ports(),
    ).ok,
  ).toBe(false);
  expect(
    beginHostOpsAction(
      s,
      caller,
      { ...params, context_usage: { ...u, session_id: "wrong" } },
      ports(),
    ).ok,
  ).toBe(false);
  const begin = value(beginHostOpsAction(s, caller, params, ports()));
  s = apply(s, begin);
  const finish = value(
    finishHostOpsAction(s, system, begin.data.action_id, ports()),
  );
  s = apply(s, finish);
  expect(
    s.assignments.find((a) => a.id === u.assignment_id)?.session_ref,
  ).toBeUndefined();
  expect(finish.data.run?.status).toBe("queued");
  expect(
    beginHostOpsAction(
      s,
      caller,
      { ...params, context_usage: { ...u, runtime_key: "null" } },
      ports(),
    ).ok,
  ).toBe(false);
});
