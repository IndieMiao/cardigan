import { expect, test } from "vitest";
import type { Assignment, Event, Run, RuntimeRef } from "../entities.js";
import {
  probeInvalidStreak,
  retirementWithdrawals,
} from "../session-maintenance.js";
import type { CommandState } from "./core.js";
import {
  beginIdleSessionRetirement,
  releaseUnresponsiveSession,
  settleIdleSessionRetirement,
  type UnresponsiveRelease,
  unresponsiveReleaseBlocker,
} from "./idle-session-retirement.js";
import { actor, apply, fixture, human, ports, value } from "./test-fixtures.js";

// C-730: a session whose idle retirement keeps being withdrawn for want of a
// process proof (probe_invalid) while its terminal stays live is released like
// a managed `assignment stop`, once the host also showed the Agent not alive.

const system = { kind: "system" as const, project_id: human.project_id };
const start = Date.parse("2030-01-01T02:00:00.000Z");

function setup() {
  const s = fixture();
  let at = start;
  const io = {
    ...ports(),
    clock: { now: () => new Date(at).toISOString() },
  };
  const ref: RuntimeRef = {
    machine_id: "local",
    runtime_machine: "fixture",
    terminal_ref: "t1",
    agent_name: "fixture",
    launch_generation: { run_id: s.runs[0]!.id, generation: "g1" },
  };
  let state: CommandState = {
    ...s,
    assignments: [
      {
        ...s.assignments[0]!,
        last_mcp_activity_at: "2030-01-01T00:00:00Z",
        runtime_ref: ref,
      },
    ],
    runs: [
      {
        ...s.runs[0]!,
        status: "completed",
        started_at: "2029-12-31T23:50:00Z",
        finished_at: "2030-01-01T00:00:00Z",
      },
    ],
  };
  const owner = () => state.assignments[0]!;
  /** One idle retirement attempt withdrawn for `reason`, 5 minutes apart. */
  const withdraw = (reason: "probe_invalid" | "terminal_busy") => {
    at += 5 * 60_000;
    state = apply(
      state,
      value(beginIdleSessionRetirement(state, system, owner().id, 60, io)),
    );
    state = apply(
      state,
      value(
        settleIdleSessionRetirement(
          state,
          system,
          owner().id,
          { outcome: "withdrawn", evidence: { stage: "probe", reason } },
          60_000,
          io,
        ),
      ),
    );
  };
  return {
    io,
    ref,
    owner,
    withdraw,
    get state() {
      return state;
    },
    set state(next: CommandState) {
      state = next;
    },
    patch(value: Partial<Assignment>) {
      state = {
        ...state,
        assignments: [{ ...owner(), ...value } as Assignment],
      };
    },
  };
}

const probe: UnresponsiveRelease = { trigger: "probe_invalid", limit: 3 };

test("the probe_invalid streak counts withdrawals of this exact session since its last sign of life", () => {
  const f = setup();
  expect(probeInvalidStreak(f.state, f.owner())).toBe(0);
  f.withdraw("probe_invalid");
  f.withdraw("probe_invalid");
  expect(probeInvalidStreak(f.state, f.owner())).toBe(2);
  // The withdrawal names its session.
  expect(
    f.state.events
      .filter((e) => e.type === "idle_session_retirement_withdrawn")
      .map((e) => (e.payload as { runtime_ref?: unknown }).runtime_ref),
  ).toEqual([f.ref, f.ref]);
  // Another reason ends the streak.
  f.withdraw("terminal_busy");
  expect(probeInvalidStreak(f.state, f.owner())).toBe(0);
  f.withdraw("probe_invalid");
  f.withdraw("probe_invalid");
  f.withdraw("probe_invalid");
  expect(probeInvalidStreak(f.state, f.owner())).toBe(3);
  // A newer session does not inherit the streak of the old terminal.
  expect(
    probeInvalidStreak(f.state, {
      ...f.owner(),
      runtime_ref: { ...f.ref, terminal_ref: "t2" },
    }),
  ).toBe(0);
  // Any MCP call or Run boundary after the withdrawals is a sign of life.
  expect(
    probeInvalidStreak(f.state, {
      ...f.owner(),
      last_mcp_activity_at: new Date(start + 3_600_000).toISOString(),
    }),
  ).toBe(0);
  expect(
    probeInvalidStreak(
      {
        ...f.state,
        runs: [
          {
            ...f.state.runs[0]!,
            finished_at: new Date(start + 3_600_000).toISOString(),
          },
        ],
      },
      f.owner(),
    ),
  ).toBe(0);
});

test("maintenance releases only after the streak and settles like a managed stop, keeping queued work", () => {
  const f = setup();
  const queued: Run = {
    ...f.state.runs[0]!,
    id: "R-9" as Run["id"],
    status: "queued",
    started_at: undefined,
    finished_at: undefined,
  } as unknown as Run;
  f.withdraw("probe_invalid");
  f.withdraw("probe_invalid");
  // New work queued while the session no longer answers (awaiting_dispatch).
  f.state = { ...f.state, runs: [...f.state.runs, queued] };
  expect(unresponsiveReleaseBlocker(f.state, f.owner(), probe)).toBe(
    "probe_streak",
  );
  expect(
    releaseUnresponsiveSession(
      f.state,
      system,
      f.owner().id,
      f.ref,
      probe,
      f.io,
    ).ok,
  ).toBe(false);
  f.state = { ...f.state, runs: f.state.runs.filter((r) => r !== queued) };
  f.withdraw("probe_invalid");
  f.state = { ...f.state, runs: [...f.state.runs, queued] };
  expect(f.owner().idle_retirement).toMatchObject({ failures: 3 });
  expect(unresponsiveReleaseBlocker(f.state, f.owner(), probe)).toBeUndefined();
  const settled = value(
    releaseUnresponsiveSession(
      f.state,
      system,
      f.owner().id,
      f.ref,
      probe,
      f.io,
    ),
  );
  expect(settled.data).toMatchObject({ runtime_ref: null });
  expect(settled.data.idle_retirement).toBeUndefined();
  expect(settled.data.session_ref).toBeUndefined();
  // The never-started queued Run stays for the new session.
  expect(settled.changes.filter((c) => c.collection === "runs")).toEqual([]);
  expect(
    settled.events.filter((e) => e.type === "session_replaced"),
  ).toMatchObject([
    {
      payload: {
        assignment_id: f.owner().id,
        reason: "agent_unresponsive",
        trigger: "probe_invalid",
        probe_invalid: 3,
        cancelled_run_ids: [],
        old_runtime_ref: f.ref,
      },
    },
  ]);
  expect(settled.timeline).toMatchObject([
    {
      type: "handoff",
      body: expect.stringContaining("连续 3 次未取得有效进程身份"),
    },
  ]);
});

test("a human stop, host operation, upgrade, Run in flight, other terminal or other actor keeps the session", () => {
  const f = setup();
  for (let i = 0; i < 3; i++) f.withdraw("probe_invalid");
  const base = f.state,
    a = f.owner();
  const io = f.io;
  const stopped: Event = {
    id: io.ids.nextEventId(),
    seq: 900,
    card_id: base.cards[0]!.id,
    type: "assignment_stopped",
    actor: human,
    payload: { assignment_id: a.id },
    created_at: io.clock.now(),
  };
  const withOwner = (patch: Partial<Assignment>): CommandState => ({
    ...base,
    assignments: [{ ...a, ...patch } as Assignment],
  });
  const running: Run = { ...base.runs[0]!, status: "running" } as Run;
  const cases: [CommandState, string | undefined][] = [
    [{ ...base, events: [...base.events, stopped] }, "stopped_by_human"],
    [
      withOwner({
        role_upgrade: { role_version: 2, previous_runtime_ref: f.ref },
      }),
      "upgrade_pending",
    ],
    [{ ...base, runs: [running] }, "run_busy"],
    [
      { ...base, runs: [{ ...base.runs[0]!, dispatch_stop: {} } as Run] },
      "operation_pending",
    ],
    [withOwner({ external: true }), "not_managed"],
    [withOwner({ runtime_ref: null }), "no_session"],
    [
      {
        ...base,
        assignments: [
          a,
          {
            ...a,
            id: "A-99" as Assignment["id"],
            work_item_id: undefined,
            runtime_ref: f.ref,
          } as Assignment,
        ],
      },
      "shared_registration",
    ],
  ];
  for (const [state, reason] of cases) {
    const owner = state.assignments[0]!;
    expect(unresponsiveReleaseBlocker(state, owner, probe)).toBe(reason);
    expect(
      releaseUnresponsiveSession(state, system, a.id, f.ref, probe, io).ok,
    ).toBe(false);
  }
  expect(
    releaseUnresponsiveSession(base, actor(), a.id, f.ref, probe, io).ok,
  ).toBe(false);
  expect(
    releaseUnresponsiveSession(
      base,
      system,
      a.id,
      { ...f.ref, terminal_ref: "t2" },
      probe,
      io,
    ).ok,
  ).toBe(false);
  expect(
    releaseUnresponsiveSession(
      base,
      system,
      a.id,
      f.ref,
      { trigger: "probe_invalid", limit: 0 },
      io,
    ).ok,
  ).toBe(false);
  expect(
    releaseUnresponsiveSession(base, system, a.id, f.ref, probe, io).ok,
  ).toBe(true);
});

test("a host operator's release cancels the Runs of that session and the Run it asked to cancel", () => {
  const f = setup();
  const a = f.owner();
  const running = { ...f.state.runs[0]!, status: "running" } as Run;
  const target = {
    ...f.state.runs[0]!,
    id: "R-8" as Run["id"],
    status: "queued",
    started_at: undefined,
    finished_at: undefined,
  } as unknown as Run;
  const pending = { ...target, id: "R-9" as Run["id"] } as Run;
  const state: CommandState = {
    ...f.state,
    assignments: [{ ...a, runtime_state: "running" }],
    runs: [running, target, pending],
  };
  const request: UnresponsiveRelease = {
    trigger: "host_ops",
    requested_by: "A-61" as Assignment["id"],
    tool: "host_ops_cancel_run",
    reason: "stuck",
    run_id: target.id,
  };
  // No streak is needed: the operator's request stands in for it.
  expect(unresponsiveReleaseBlocker(state, a, request)).toBeUndefined();
  const settled = value(
    releaseUnresponsiveSession(state, system, a.id, f.ref, request, f.io),
  );
  expect(settled.data).toMatchObject({
    runtime_ref: null,
    runtime_state: "idle",
  });
  expect(
    settled.changes
      .filter((c) => c.collection === "runs")
      .map((c) => [c.entity.id, (c.entity as Run).status]),
  ).toEqual([
    [running.id, "cancelled"],
    [target.id, "cancelled"],
  ]);
  expect(settled.events.at(-1)).toMatchObject({
    type: "session_replaced",
    payload: {
      reason: "agent_unresponsive",
      trigger: "host_ops",
      requested_by: "A-61",
      tool: "host_ops_cancel_run",
      cancelled_run_ids: [running.id, target.id],
    },
  });
  expect(settled.timeline[0]?.body).toContain("主机运维 A-61 请求取消 Run");
  // A finished target or an empty reason is refused.
  expect(
    unresponsiveReleaseBlocker(
      { ...state, runs: [{ ...target, status: "cancelled" } as Run] },
      a,
      request,
    ),
  ).toBe("run_changed");
  expect(
    releaseUnresponsiveSession(
      state,
      system,
      a.id,
      f.ref,
      { ...request, reason: " " },
      f.io,
    ).ok,
  ).toBe(false);
});

// C-739: the system finished the Run; the old turn stayed unconfirmed while
// work waited and the checkout was clean.
function systemEnded() {
  const f = setup();
  const [first] = f.state.runs;
  const [card] = f.state.cards;
  if (!first || !card) throw new Error("fixture");
  const ended = { ...first, outcome: "blocked" } as Run;
  const queued = {
    ...ended,
    id: "R-9" as Run["id"],
    status: "queued",
    outcome: undefined,
    started_at: undefined,
    finished_at: undefined,
  } as unknown as Run;
  const finished: Event = {
    id: f.io.ids.nextEventId(),
    seq: 901,
    card_id: card.id,
    type: "run_finished",
    actor: system,
    payload: { run_id: ended.id, finished_by: "system" },
    created_at: "2030-01-01T00:00:00Z",
  };
  f.state = {
    ...f.state,
    runs: [ended, queued],
    events: [...f.state.events, finished],
  };
  const request: UnresponsiveRelease = {
    trigger: "system_turn",
    system_finished_run_id: ended.id,
    waited_ms: 180_000,
    workspace: "clean",
  };
  return { f, ended, queued, card, request };
}

test("C-739: a system-ended turn is released like a managed stop, keeping the queued Run", () => {
  const { f, ended, queued, request } = systemEnded();
  const a = f.owner();
  // No probe streak is needed: the unconfirmed turn stands in for it.
  expect(probeInvalidStreak(f.state, a)).toBe(0);
  expect(unresponsiveReleaseBlocker(f.state, a, request)).toBeUndefined();
  const settled = value(
    releaseUnresponsiveSession(f.state, system, a.id, f.ref, request, f.io),
  );
  expect(settled.data).toMatchObject({ runtime_ref: null });
  expect(settled.changes.filter((c) => c.collection === "runs")).toEqual([]);
  expect(settled.events.at(-1)).toMatchObject({
    type: "session_replaced",
    payload: {
      assignment_id: a.id,
      reason: "system_turn_unconfirmed",
      trigger: "system_turn",
      system_finished_run_id: ended.id,
      waited_ms: 180_000,
      workspace: "clean",
      cancelled_run_ids: [],
      old_runtime_ref: f.ref,
    },
  });
  expect(settled.timeline[0]?.body).toContain(
    `系统代为结束 ${ended.id} 后，${a.id}（local）的旧回合 3 分钟仍确认不了是否结束，工作区干净`,
  );
  expect(f.state.runs.find((r) => r.id === queued.id)?.status).toBe("queued");
});

test("C-739: another ended turn, a Run in flight, a retirement or a human stop keeps the session", () => {
  const { f, ended, card, request } = systemEnded();
  const base = f.state,
    a = f.owner();
  const stopped: Event = {
    id: f.io.ids.nextEventId(),
    seq: 902,
    card_id: card.id,
    type: "assignment_stopped",
    actor: human,
    payload: { assignment_id: a.id, hold: false },
    created_at: f.io.clock.now(),
  };
  const cases: [CommandState, Assignment, string][] = [
    // The ended Run was not left blocked by the system: not this turn.
    [
      {
        ...base,
        runs: base.runs.map((r) =>
          r.id === ended.id ? ({ ...r, outcome: "completed" } as Run) : r,
        ),
      },
      a,
      "run_changed",
    ],
    [
      {
        ...base,
        runs: base.runs.map((r) =>
          r.id === ended.id ? r : ({ ...r, status: "running" } as Run),
        ),
      },
      a,
      "run_busy",
    ],
    [
      base,
      { ...a, idle_retirement: { phase: "waiting" } } as unknown as Assignment,
      "session_maintenance",
    ],
    [{ ...base, events: [...base.events, stopped] }, a, "stopped_by_human"],
  ];
  for (const [state, owner, reason] of cases) {
    expect(unresponsiveReleaseBlocker(state, owner, request)).toBe(reason);
    expect(
      releaseUnresponsiveSession(
        { ...state, assignments: [owner] },
        system,
        a.id,
        f.ref,
        request,
        f.io,
      ).ok,
    ).toBe(false);
  }
  // A wrong ended Run id, an invalid wait or workspace, or another actor.
  for (const bad of [
    { ...request, system_finished_run_id: "R-77" as Run["id"] },
    { ...request, waited_ms: -1 },
    { ...request, workspace: "dirty" as never },
  ])
    expect(
      releaseUnresponsiveSession(base, system, a.id, f.ref, bad, f.io).ok,
    ).toBe(false);
  expect(
    releaseUnresponsiveSession(base, actor(), a.id, f.ref, request, f.io).ok,
  ).toBe(false);
});

test("C-739: work waiting while idle retirement keeps withdrawing releases the session after two withdrawals", () => {
  const f = setup();
  const [first] = f.state.runs;
  if (!first) throw new Error("fixture");
  const queued = {
    ...first,
    id: "R-9" as Run["id"],
    status: "queued",
    started_at: undefined,
    finished_at: undefined,
  } as unknown as Run;
  const request: UnresponsiveRelease = {
    trigger: "retirement_withdrawn",
    withdrawals: 2,
    waited_ms: 240_000,
    workspace: "clean",
  };
  f.withdraw("terminal_busy");
  f.state = { ...f.state, runs: [...f.state.runs, queued] };
  expect(retirementWithdrawals(f.state, f.owner())).toBe(1);
  expect(unresponsiveReleaseBlocker(f.state, f.owner(), request)).toBe(
    "withdrawal_streak",
  );
  f.state = { ...f.state, runs: f.state.runs.filter((r) => r !== queued) };
  f.withdraw("probe_invalid");
  f.state = { ...f.state, runs: [...f.state.runs, queued] };
  // Any withdrawal reason counts, unlike the C-730 probe streak.
  expect(retirementWithdrawals(f.state, f.owner())).toBe(2);
  expect(probeInvalidStreak(f.state, f.owner())).toBe(1);
  expect(f.owner().idle_retirement?.phase).toBe("waiting");
  expect(
    unresponsiveReleaseBlocker(f.state, f.owner(), request),
  ).toBeUndefined();
  const settled = value(
    releaseUnresponsiveSession(
      f.state,
      system,
      f.owner().id,
      f.ref,
      request,
      f.io,
    ),
  );
  expect(settled.data).toMatchObject({ runtime_ref: null });
  expect(settled.data.idle_retirement).toBeUndefined();
  expect(settled.changes.filter((c) => c.collection === "runs")).toEqual([]);
  expect(settled.events.at(-1)).toMatchObject({
    type: "session_replaced",
    payload: {
      reason: "retirement_withdrawn",
      trigger: "retirement_withdrawn",
      withdrawals: 2,
      waited_ms: 240_000,
      workspace: "clean",
      old_runtime_ref: f.ref,
    },
  });
  expect(settled.timeline[0]?.body).toContain(
    "有待办 4 分钟仍派不出新 Run，空闲回收已 2 次被撤回，工作区干净",
  );
  // A sign of life restarts the count; a stopping retirement or a bad
  // request keeps the session.
  expect(
    retirementWithdrawals(f.state, {
      ...f.owner(),
      last_mcp_activity_at: new Date(start + 3_600_000).toISOString(),
    }),
  ).toBe(0);
  const stopping = {
    ...f.owner(),
    idle_retirement: { ...f.owner().idle_retirement, phase: "stopping" },
  } as Assignment;
  expect(unresponsiveReleaseBlocker(f.state, stopping, request)).toBe(
    "session_maintenance",
  );
  for (const bad of [
    { ...request, withdrawals: 1 },
    { ...request, waited_ms: Number.NaN },
  ])
    expect(
      releaseUnresponsiveSession(
        f.state,
        system,
        f.owner().id,
        f.ref,
        bad,
        f.io,
      ).ok,
    ).toBe(false);
});
