import { expect, test } from "vitest";
import type { Assignment, Event, Run } from "../entities.js";
import {
  sessionMaintenanceBasis,
  sessionMaintenanceCandidate,
  sessionMaintenanceNeedsAttention,
  sessionMaintenanceView,
} from "../session-maintenance.js";
import type { CommandState } from "./core.js";
import {
  beginIdleSessionRetirement,
  confirmKeptShellExit,
  confirmWaitingRetirementExit,
  handoffIdleSessionRetirement,
  settleIdleSessionRetirement,
  trackRetirementDispatch,
} from "./idle-session-retirement.js";
import { queueRun } from "./launch.js";
import { recordSessionMaintenance } from "./session-maintenance.js";
import { actor, apply, fixture, human, ports, value } from "./test-fixtures.js";

const now = "2030-01-01T02:00:00.000Z";
const system = { kind: "system" as const, project_id: human.project_id };
function setup(): CommandState {
  const s = fixture();
  return {
    ...s,
    assignments: [
      {
        ...s.assignments[0]!,
        last_mcp_activity_at: "2030-01-01T00:00:00Z",
        runtime_ref: {
          machine_id: "local",
          runtime_machine: "fixture",
          terminal_ref: "t1",
          agent_name: "fixture",
          launch_generation: { run_id: s.runs[0]!.id, generation: "g1" },
        },
      },
    ],
    runs: [
      {
        ...s.runs[0]!,
        status: "completed",
        finished_at: "2030-01-01T00:00:00Z",
      },
    ],
  };
}
const record = (state: CommandState, at = now) => {
  const a = state.assignments[0]!;
  return recordSessionMaintenance(
    state,
    system,
    a.id,
    {
      ...sessionMaintenanceCandidate(state, a, at),
      ...(sessionMaintenanceCandidate(state, a, at).candidate
        ? { reason: "unsupported_capability" as const }
        : {}),
      basis: sessionMaintenanceBasis(state, a),
      threshold_minutes: 60,
    },
    { ...ports(), clock: { now: () => at } },
  );
};

test("maintenance publication basis preserves project/actor scope and sequence order across rollback", () => {
  const state = setup();
  const owner = state.assignments[0];
  const card = state.cards[0];
  if (!owner || !card) throw new Error("Missing fixture");
  const io = ports();
  const receipt = (seq: number) => ({
    id: io.ids.nextEventId(),
    seq,
    type: "host_role_pack_published",
    actor: system,
    payload: {},
    created_at: now,
  });
  const latest = receipt(20),
    older = receipt(1);
  const before = {
    ...state,
    events: [
      latest,
      older,
      { ...receipt(100), actor: human },
      { ...receipt(101), card_id: card.id },
      {
        ...receipt(102),
        actor: { ...system, project_id: "other" as typeof system.project_id },
      },
    ],
  };
  const basis = sessionMaintenanceBasis(before, owner);
  expect(JSON.parse(basis).publication).toBe(latest.id);
  const next = receipt(21);
  expect(
    JSON.parse(
      sessionMaintenanceBasis(
        { ...before, events: [...before.events, next] },
        owner,
      ),
    ).publication,
  ).toBe(next.id);
  expect(sessionMaintenanceBasis(before, owner)).toBe(basis);
});

test("retirement dispatch diagnostics follow one waiting session, not the Run or terminal address alone", () => {
  const initial = setup(),
    owner = initial.assignments[0]!,
    run = initial.runs[0]!,
    ref = owner.runtime_ref!;
  const io = { ...ports(), clock: { now: () => now } };
  const a = {
    ...owner,
    idle_retirement: {
      phase: "waiting" as const,
      runtime_ref: ref,
      started_at: now,
      threshold_minutes: 60,
      failures: 2,
    },
  };
  const state = {
    ...initial,
    assignments: [a],
    runs: [{ ...run, status: "queued" as const }],
  };
  const conflict = { source: "owner", status: "runtime_conflict" } as const;
  expect(
    trackRetirementDispatch(state, actor(), a, run.id, conflict, io).ok,
  ).toBe(false);
  const first = value(
    trackRetirementDispatch(state, system, a, run.id, conflict, io),
  );
  const waiting = apply(state, first),
    current = waiting.assignments[0]!;
  const eventId = first.events[0]!.id;
  expect(current.idle_retirement).toMatchObject({
    failures: 2,
    dispatch_wait: { ...conflict, event_id: eventId },
  });
  expect(
    value(
      trackRetirementDispatch(waiting, system, current, run.id, conflict, io),
    ).changes,
  ).toEqual([]);
  expect(
    value(trackRetirementDispatch(waiting, system, a, run.id, "woken", io))
      .changes,
  ).toEqual([]);
  const reusedAddress = {
    ...current,
    runtime_ref: {
      ...ref,
      launch_generation: { run_id: run.id, generation: "other" },
    },
  };
  expect(
    value(
      trackRetirementDispatch(
        waiting,
        system,
        reusedAddress,
        run.id,
        "woken",
        io,
      ),
    ).events,
  ).toEqual([]);
  const changed = value(
    trackRetirementDispatch(
      waiting,
      system,
      current,
      run.id,
      { source: "owner", status: "runtime_timeout" },
      io,
    ),
  );
  expect(changed.events.map((e) => e.type)).toEqual([
    "retirement_dispatch_wait_changed",
  ]);
  const resumed = value(
    trackRetirementDispatch(
      apply(waiting, changed),
      system,
      current,
      run.id,
      "woken",
      io,
    ),
  );
  expect(resumed.events).toMatchObject([
    {
      type: "retirement_dispatch_resumed",
      payload: { retirement_wait_event_id: eventId },
    },
  ]);
  expect(resumed.token_requests).toEqual([]);
  expect(apply(waiting, resumed).assignments[0]?.runtime_ref).toEqual(ref);
});

test("retirement fences launch without revoking identity; only trusted exit clears the exact session", () => {
  const state = setup(),
    a = state.assignments[0]!,
    io = { ...ports(), clock: { now: () => now } };
  const evidence = {
    stage: "HUP",
    reason: "hc_failed",
    runtime_code: "runtime_timeout",
  } as const;
  const begun = value(beginIdleSessionRetirement(state, system, a.id, 60, io));
  const pending = apply(state, begun);
  expect(begun.token_requests).toEqual([]);
  expect(
    queueRun(
      pending,
      system,
      {
        assignment_id: a.id,
        kind: "followup",
        model: "fixture",
        agent_cli_version: "fixture",
      },
      io,
    ),
  ).toMatchObject({ ok: false });
  const unknown = value(
    settleIdleSessionRetirement(
      pending,
      system,
      a.id,
      { outcome: "uncertain", evidence },
      60000,
      io,
    ),
  );
  const refused = value(
    settleIdleSessionRetirement(
      pending,
      system,
      a.id,
      { outcome: "withdrawn", evidence },
      60000,
      io,
    ),
  );
  expect(refused.events[0]).toMatchObject({
    type: "idle_session_retirement_withdrawn",
    payload: { assignment_id: a.id, retry: true, evidence },
  });
  expect(refused.data.idle_retirement).toMatchObject({
    phase: "waiting",
    evidence,
  });
  expect(refused.data.runtime_ref).toEqual(a.runtime_ref);
  const waiting = apply(pending, refused);
  const oldRef = a.runtime_ref!;
  expect(
    confirmWaitingRetirementExit(
      waiting,
      system,
      a.id,
      { ...oldRef, terminal_ref: "other" },
      io,
    ).ok,
  ).toBe(false);
  expect(
    confirmWaitingRetirementExit(pending, system, a.id, oldRef, io).ok,
  ).toBe(false);
  expect(
    confirmWaitingRetirementExit(waiting, actor(), a.id, oldRef, io).ok,
  ).toBe(false);
  expect(
    value(confirmWaitingRetirementExit(waiting, system, a.id, oldRef, io)).data
      .runtime_ref,
  ).toBeNull();
  expect(unknown.data.runtime_ref).toEqual(a.runtime_ref);
  expect(unknown.data.idle_retirement?.phase).toBe("stopping");
  // Even if a signal attempt reported the same platform error as a read-only probe,
  // neither new nor legacy signal-capable claims can release the dispatch fence.
  expect(
    settleIdleSessionRetirement(
      apply(pending, unknown),
      system,
      a.id,
      {
        outcome: "observing",
        evidence: { stage: "HUP", reason: "pidfd_unavailable" },
      },
      60000,
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  const changed = {
    ...pending,
    assignments: pending.assignments.map((owner) => ({
      ...owner,
      runtime_ref: { ...owner.runtime_ref!, terminal_ref: "new" },
    })),
  };
  expect(
    settleIdleSessionRetirement(
      changed,
      system,
      a.id,
      { outcome: "exited" },
      60000,
      io,
    ),
  ).toMatchObject({ ok: false });
  const exited = value(
    settleIdleSessionRetirement(
      pending,
      system,
      a.id,
      { outcome: "exited" },
      60000,
      io,
    ),
  );
  expect(exited.data.runtime_ref).toBeNull();
  expect(exited.data.role_version).toBe(a.role_version);
  expect(exited.data.idle_retirement).toBeUndefined();
  expect(
    value(
      settleIdleSessionRetirement(
        apply(pending, exited),
        system,
        a.id,
        { outcome: "exited" },
        60000,
        io,
      ),
    ).events,
  ).toEqual([]);
});
test("maintenance is an observation: no lifecycle, role, run, token or workspace changes", () => {
  const state = setup(),
    result = value(record(state));
  const { session_maintenance: fact, ...a } = result.data;
  expect(a).toEqual(state.assignments[0]);
  expect(fact).toMatchObject({
    candidate: true,
    reason: "unsupported_capability",
    evaluated_at: now,
  });
  expect(result.changes.map((c) => c.collection)).toEqual(["assignments"]);
  expect(result.token_requests).toEqual([]);
  expect(result.events[0]?.payload).not.toHaveProperty("basis");
  expect(result.events[0]?.payload).not.toHaveProperty("runtime_ref");
  const input = {
    basis: sessionMaintenanceBasis(state, state.assignments[0]!),
    reason: "unsupported_capability" as const,
    candidate: true,
    threshold_minutes: 60,
  };
  expect(
    recordSessionMaintenance(
      state,
      actor(),
      state.assignments[0]!.id,
      input,
      ports(),
    ),
  ).toMatchObject({ ok: false });
  expect(
    recordSessionMaintenance(
      state,
      { ...system, project_id: "other" },
      state.assignments[0]!.id,
      input,
      ports(),
    ),
  ).toMatchObject({ ok: false });
});
test("routine observations stay in diagnostics without becoming attention or changing retirement eligibility", () => {
  const state = setup();
  const effect = value(
    recordSessionMaintenance(
      state,
      system,
      state.assignments[0]!.id,
      {
        reason: "recent_activity",
        candidate: false,
        basis: sessionMaintenanceBasis(state, state.assignments[0]!),
        threshold_minutes: 60,
      },
      ports(),
    ),
  );
  const next = apply(state, effect);
  const view = sessionMaintenanceView(next, next.assignments[0]!);
  expect(view?.reason).toBe("recent_activity");
  expect(sessionMaintenanceNeedsAttention(view!.reason)).toBe(false);
  expect(sessionMaintenanceCandidate(next, next.assignments[0]!, now)).toEqual(
    sessionMaintenanceCandidate(state, state.assignments[0]!, now),
  );
  // A new runtime must surface the stale observation, even if the old reason was routine.
  const changed = {
    ...next.assignments[0]!,
    runtime_ref: { ...next.assignments[0]!.runtime_ref!, terminal_ref: "new" },
  };
  const stale = sessionMaintenanceView(
    { ...next, assignments: [changed] },
    changed,
  );
  expect(stale?.reason).toBe("stale");
  expect(sessionMaintenanceNeedsAttention(stale!.reason)).toBe(true);
});
test.each(["mcp", "run_finish", "run_status"] as const)(
  "advancing %s refreshes observations without repeating the same cause",
  (activity) => {
    let state = setup();
    if (activity === "run_status")
      state = {
        ...state,
        runs: state.runs.map((r) => ({ ...r, status: "running" })),
      };
    let firstSince: string | undefined;
    for (let minute = 0; minute < 5; minute++) {
      const at = new Date(Date.parse(now) + minute * 60_000).toISOString();
      state = {
        ...state,
        assignments: state.assignments.map((a) => ({
          ...a,
          last_mcp_activity_at: activity === "mcp" ? at : now,
        })),
        runs: state.runs.map((r) => ({
          ...r,
          ...(activity === "run_finish" ? { finished_at: at } : {}),
          ...(activity === "run_status"
            ? { status: minute % 2 ? ("acked" as const) : ("running" as const) }
            : {}),
        })),
      };
      const effect = value(record(state, at));
      expect(effect.data.session_maintenance?.reason).toBe(
        activity === "run_status" ? "run_busy" : "recent_activity",
      );
      expect(effect.events.map((e) => e.type)).toEqual(
        minute === 0 ? ["session_maintenance_changed"] : [],
      );
      firstSince ??= effect.data.session_maintenance?.since;
      expect(effect.data.session_maintenance?.since).toBe(firstSince);
      expect(effect.data.session_maintenance?.evaluated_at).toBe(at);
      state = JSON.parse(JSON.stringify(apply(state, effect))) as CommandState;
      expect(sessionMaintenanceView(state, state.assignments[0]!)?.reason).toBe(
        effect.data.session_maintenance?.reason,
      );
      expect(
        sessionMaintenanceView(state, state.assignments[0]!),
      ).not.toHaveProperty("session_basis");
    }
    state = {
      ...state,
      runs: state.runs.map((r) => ({ ...r, status: "completed" })),
    };
    const changed = value(record(state, "2030-01-01T04:00:00Z"));
    expect(changed.events.map((e) => e.type)).toEqual([
      "session_maintenance_changed",
    ]);
    expect(changed.data.session_maintenance?.reason).toBe(
      "unsupported_capability",
    );
    expect(changed.data.session_maintenance?.since).toBe(
      "2030-01-01T04:00:00Z",
    );
  },
);

test("activity refresh preserves a continuous notice, while a new generation starts its own cause", () => {
  let state = apply(setup(), value(record(setup())));
  state = {
    ...state,
    assignments: state.assignments.map((a) => ({
      ...a,
      last_mcp_activity_at: "2030-01-01T00:01:00Z",
    })),
  };
  let effect = value(record(state, "2030-01-01T02:15:00Z"));
  expect(effect.events.map((e) => e.type)).toEqual([
    "session_maintenance_attention",
  ]);
  state = JSON.parse(JSON.stringify(apply(state, effect))) as CommandState;
  state = {
    ...state,
    assignments: state.assignments.map((a) => ({
      ...a,
      last_mcp_activity_at: "2030-01-01T00:02:00Z",
    })),
  };
  effect = value(record(state, "2030-01-01T02:16:00Z"));
  expect(effect.events).toEqual([]);
  expect(effect.data.session_maintenance?.notice_sent).toBe(true);
  expect(effect.data.session_maintenance?.since).toBe(now);
  state = apply(state, effect);
  state = {
    ...state,
    assignments: state.assignments.map((a) => ({
      ...a,
      runtime_ref: {
        ...a.runtime_ref!,
        launch_generation: { run_id: state.runs[0]!.id, generation: "g2" },
      },
    })),
  };
  effect = value(record(state, "2030-01-01T02:17:00Z"));
  expect(effect.events.map((e) => e.type)).toEqual([
    "session_maintenance_changed",
  ]);
  expect(effect.data.session_maintenance?.notice_sent).toBeUndefined();
  expect(effect.data.session_maintenance?.since).toBe("2030-01-01T02:17:00Z");
});

test("legacy observations acquire a stable binding without replaying an unchanged notice", () => {
  let state = apply(setup(), value(record(setup())));
  state = apply(state, value(record(state, "2030-01-01T02:15:00Z")));
  state = {
    ...state,
    assignments: state.assignments.map((a) => {
      const { session_basis: _session, ...old } = a.session_maintenance!;
      return { ...a, session_maintenance: old };
    }),
  };
  const effect = value(record(state, "2030-01-01T02:16:00Z"));
  expect(effect.events).toEqual([]);
  expect(effect.data.session_maintenance?.notice_sent).toBe(true);
  expect(effect.data.session_maintenance?.session_basis).toBeTruthy();
});

test("candidate boundary and missing/future activity are conservative", () => {
  const state = setup(),
    a = state.assignments[0]!;
  const { last_mcp_activity_at: _activity, ...withoutActivity } = a;
  const { work_item_id: _item, ...withoutItem } = a;
  expect(sessionMaintenanceCandidate(state, a, "2030-01-01T01:00:00Z")).toEqual(
    { candidate: false, reason: "recent_activity" },
  );
  expect(
    sessionMaintenanceCandidate(state, a, "2030-01-01T01:00:00.001Z").candidate,
  ).toBe(true);
  expect(sessionMaintenanceCandidate(state, a, now, 120).candidate).toBe(false);
  expect(sessionMaintenanceCandidate(state, withoutActivity, now).reason).toBe(
    "activity_unknown",
  );
  expect(
    sessionMaintenanceCandidate(
      state,
      { ...a, last_mcp_activity_at: "2031-01-01T00:00:00Z" },
      now,
    ).reason,
  ).toBe("activity_unknown");
  expect(
    sessionMaintenanceCandidate(state, { ...a, external: true }, now).reason,
  ).toBe("external");
  expect(
    sessionMaintenanceCandidate(
      state,
      { ...withoutItem, scope: "standing", role_id: "pm" },
      now,
    ).reason,
  ).toBe("standing");
  expect(
    sessionMaintenanceCandidate(
      { ...state, runs: state.runs.map((r) => ({ ...r, status: "unknown" })) },
      a,
      now,
    ).reason,
  ).toBe("run_busy");
});
test("repeated scans and restart notify once per continuous cause; recovery and new generation invalidate old facts", () => {
  let state = apply(setup(), value(record(setup())));
  let result = value(record(state, "2030-01-01T02:14:00Z"));
  expect(result.events).toEqual([]);
  state = apply(state, result);
  result = value(record(state, "2030-01-01T02:15:00Z"));
  expect(result.events.map((e) => e.type)).toEqual([
    "session_maintenance_attention",
  ]);
  state = JSON.parse(JSON.stringify(apply(state, result))) as CommandState;
  expect(value(record(state, "2030-01-01T02:16:00Z")).events).toEqual([]);
  const a = state.assignments[0]!;
  const replaced = {
    ...state,
    assignments: [
      {
        ...a,
        runtime_ref: {
          ...a.runtime_ref!,
          launch_generation: {
            run_id: state.runs[0]!.id,
            generation: "g2",
          },
        },
      },
    ],
  };
  expect(
    sessionMaintenanceView(replaced, replaced.assignments[0]!)?.reason,
  ).toBe("stale");
  const late = recordSessionMaintenance(
    replaced,
    system,
    a.id,
    {
      basis: sessionMaintenanceBasis(state, a),
      reason: "runtime_unavailable",
      candidate: true,
      threshold_minutes: 60,
    },
    { ...ports(), clock: { now: () => "2030-01-01T02:17:00Z" } },
  );
  expect(value(late).changes).toEqual([]);
  const recovered = { ...state, assignments: [{ ...a, runtime_ref: null }] };
  result = value(record(recovered, "2030-01-01T02:17:00Z"));
  expect(result.data.session_maintenance).toMatchObject({
    reason: "no_session",
    candidate: false,
  });
  expect(result.data.session_maintenance?.notice_sent).toBeUndefined();
});

test("shared workspace Run history fences retirement; a different machine's history is excluded", () => {
  const initial = setup(),
    a = { ...initial.assignments[0]!, worktree_path: "/fixture/shared" };
  const sibling = { ...a, id: "A-2" as typeof a.id };
  const run = {
    ...initial.runs[0]!,
    id: "R-2" as (typeof initial.runs)[number]["id"],
    assignment_id: sibling.id,
    status: "running" as const,
  };
  const state = {
    ...initial,
    assignments: [sibling, a],
    runs: [run, ...initial.runs],
  };
  expect(sessionMaintenanceCandidate(state, a, now).reason).toBe("run_busy");
  expect(
    JSON.parse(sessionMaintenanceBasis(state, a)).runs.map(
      ([id]: [string]) => id,
    ),
  ).toEqual([initial.runs[0]!.id, run.id].sort());
  const isolated = {
    ...state,
    assignments: [{ ...sibling, machine_id: "other" }, a],
  };
  expect(sessionMaintenanceCandidate(isolated, a, now).candidate).toBe(true);
  expect(JSON.parse(sessionMaintenanceBasis(isolated, a)).runs).toHaveLength(1);
});

test("retention cap only parks an exact kept-and-alive waiting ref, including legacy counts", () => {
  const s = setup(),
    a = s.assignments[0]!;
  for (const failures of [2, 3, 40]) {
    const retained = {
      ...a,
      idle_retirement: {
        phase: "waiting" as const,
        runtime_ref: a.runtime_ref!,
        started_at: now,
        threshold_minutes: 60,
        failures,
        evidence: {
          stage: "confirm" as const,
          reason: "kept_terminal" as const,
          observation: "alive" as const,
        },
      },
    };
    const state = { ...s, assignments: [retained] };
    expect(sessionMaintenanceCandidate(state, retained, now)).toEqual(
      failures < 3
        ? { candidate: true, reason: "idle_candidate" }
        : { candidate: false, reason: "retained_for_dispatch" },
    );
    expect(
      beginIdleSessionRetirement(state, system, a.id, 60, {
        ...ports(),
        clock: { now: () => now },
      }).ok,
    ).toBe(failures < 3);
  }
});

test.each(["timeout", "uncertain", "withdrawn"] as const)(
  "Darwin %s handoff preserves the exact session and distinguishes an outstanding stop",
  (outcome) => {
    const s = setup(),
      a = {
        ...s.assignments[0]!,
        machine_id: "fixture-worker",
        runtime_ref: {
          ...s.assignments[0]!.runtime_ref!,
          machine_id: "fixture-worker",
        },
      },
      io = { ...ports(), clock: { now: () => now } };
    const base = {
      ...s,
      assignments: [a],
      machines: s.machines!.map((m) => ({
        ...m,
        id: "fixture-worker",
        os: "darwin",
      })),
    };
    const pending = apply(
      base,
      value(beginIdleSessionRetirement(base, system, a.id, 60, io)),
    );
    const state = {
      ...pending,
      assignments: pending.assignments.map((v) => ({
        ...v,
        idle_retirement: { ...v.idle_retirement!, failures: 2 },
      })),
    };
    const settled = value(
      settleIdleSessionRetirement(
        state,
        system,
        a.id,
        {
          outcome,
          evidence: { reason: "confirmation_pending", stage: "confirm" },
        },
        1,
        io,
      ),
    );
    expect(settled.data.idle_retirement).toMatchObject({
      handoff: true,
      failures: 3,
      phase: outcome === "withdrawn" ? "waiting" : "stopping",
    });
    expect(settled.token_requests).toEqual([]);
    expect(settled.data.runtime_ref).toEqual(a.runtime_ref);
    expect(
      settled.events.filter(
        (e) => e.type === "idle_session_retirement_handed_off",
      ),
    ).toHaveLength(1);
    const handed = apply(state, settled);
    expect(
      sessionMaintenanceCandidate(handed, settled.data, now).candidate,
    ).toBe(false);
    expect(
      value(handoffIdleSessionRetirement(handed, system, a.id, io)).changes,
    ).toHaveLength(0);
    expect(beginIdleSessionRetirement(handed, system, a.id, 60, io).ok).toBe(
      false,
    );
  },
);

test("C-667: a closed kept shell settles only the exact idle session and keeps queued work", () => {
  const s = setup(),
    a = s.assignments[0]!,
    io = { ...ports(), clock: { now: () => now } };
  const ref = a.runtime_ref!;
  const waiting = {
    phase: "waiting" as const,
    runtime_ref: ref,
    started_at: now,
    threshold_minutes: 60,
    failures: 3,
    evidence: { stage: "probe" as const, reason: "kept_terminal" as const },
  };
  const handed: Assignment = {
    ...a,
    runtime_state: "running",
    idle_retirement: { ...waiting, handoff: true },
  };
  const queued: Run = {
    ...s.runs[0]!,
    id: "R-9" as Run["id"],
    status: "queued",
  };
  const base: CommandState = {
    ...s,
    assignments: [handed],
    runs: [...s.runs, queued],
  };
  const settled = value(confirmKeptShellExit(base, system, a.id, ref, io));
  expect(settled.data.runtime_ref).toBeNull();
  expect(settled.data.idle_retirement).toBeUndefined();
  expect(settled.data.runtime_state).toBe("idle");
  expect(settled.changes.filter((c) => c.collection === "runs")).toEqual([]);
  expect(
    settled.events.filter((e) => e.type === "session_replaced"),
  ).toMatchObject([
    {
      payload: {
        assignment_id: a.id,
        reason: "agent_exited",
        old_runtime_ref: ref,
      },
    },
  ]);
  const owner = (patch: Partial<Assignment>): CommandState => ({
    ...base,
    assignments: [{ ...handed, ...patch } as Assignment],
  });
  const stopped: Event = {
    id: io.ids.nextEventId(),
    seq: 99,
    card_id: s.cards[0]!.id,
    type: "assignment_stopped",
    actor: human,
    payload: { assignment_id: a.id },
    created_at: now,
  };
  // C-672: a retirement stop whose exit was never confirmed (the terminal
  // stayed live) is finished by the same proof; nothing else is signalled.
  for (const pending of [
    { ...waiting, phase: "stopping" as const },
    { ...waiting, phase: "stopping" as const, observe_only: true as const },
    waiting,
  ]) {
    const finished = value(
      confirmKeptShellExit(
        owner({ idle_retirement: pending }),
        system,
        a.id,
        ref,
        io,
      ),
    );
    expect(finished.data.runtime_ref).toBeNull();
    expect(finished.data.idle_retirement).toBeUndefined();
  }
  // Only the system, only this exact reference, never with started or
  // stopping Runs, a human stop or an upgrade.
  const refused = [
    confirmKeptShellExit(base, actor(), a.id, ref, io),
    confirmKeptShellExit(
      base,
      system,
      a.id,
      { ...ref, terminal_ref: "t2" },
      io,
    ),
    confirmKeptShellExit(
      { ...base, runs: [{ ...queued, status: "running" }] },
      system,
      a.id,
      ref,
      io,
    ),
    confirmKeptShellExit(
      { ...base, runs: [{ ...s.runs[0]!, dispatch_stop: {} } as Run] },
      system,
      a.id,
      ref,
      io,
    ),
    confirmKeptShellExit(
      owner({
        role_upgrade: {
          role_version: 2,
          previous_runtime_ref: ref,
          started_at: now,
        },
      }),
      system,
      a.id,
      ref,
      io,
    ),
    confirmKeptShellExit(
      { ...base, events: [...base.events, stopped] },
      system,
      a.id,
      ref,
      io,
    ),
  ];
  for (const effect of refused) expect(effect.ok).toBe(false);
});
