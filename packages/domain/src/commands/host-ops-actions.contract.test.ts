import { expect, test } from "vitest";
import type { Actor, Assignment, Delivery } from "../entities.js";
import {
  HOST_OPS_ROLE_TOOLS,
  type HostOpsExecutionTool,
  hostOpsPending,
} from "../host-ops.js";
import { completeHumanAction } from "./coordination.js";
import { CommandDraft, type CommandState } from "./core.js";
import {
  beginHostOpsAction,
  finishHostOpsAction,
  hostOpsExitConfirmation,
  hostOpsReadDiagnostics,
  prepareHostOpsAction,
  requestHostOpsExitConfirmation,
} from "./host-ops-actions.js";
import { abortDispatch, acknowledgeRun, queueRun } from "./launch.js";
import { releaseAssignment } from "./release.js";
import { conflictRepairEvent } from "./review-round.js";
import { pauseStandingAssignment } from "./standing.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  id,
  now,
  ports,
  role,
  subject,
  value,
} from "./test-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

const { work_item_id: _work, ...opsFields } = assignment(10, "host_ops");
const ops: Assignment = { ...opsFields, scope: "standing" };
const caller = {
  ...actor(10, "host_ops"),
  allowed_tools: HOST_OPS_ROLE_TOOLS,
} as Extract<Actor, { kind: "assignment" }>;
const snapshot = { model: "test", agent_cli_version: "test" };
function base(): CommandState {
  const s = fixture();
  return {
    ...s,
    roles: [
      ...s.roles,
      { ...role("host_ops"), allowed_tools: HOST_OPS_ROLE_TOOLS },
    ],
    assignments: [...s.assignments, ops],
  };
}
const tools: HostOpsExecutionTool[] = [
  "host_ops_restart_assignment",
  "host_ops_cancel_run",
  "host_ops_restart_standing_pm",
];
const params = (tool: HostOpsExecutionTool) => ({
  tool,
  target_id:
    tool === "host_ops_cancel_run"
      ? id("run", 1)
      : tool === "host_ops_restart_standing_pm"
        ? id("assignment", 4)
        : id("assignment", 1),
  reason: "Recover stalled execution",
  snapshot,
});

test.each(tools)(
  "%s requires this project's active standing host_ops and its exact token/role permission",
  (tool) => {
    const s = base();
    const before = JSON.stringify(s);
    for (const a of [
      human,
      actor(4, "pm"),
      { ...caller, project_id: "other" },
      {
        ...caller,
        allowed_tools: HOST_OPS_ROLE_TOOLS.filter((t) => t !== tool),
      },
    ]) {
      expect(beginHostOpsAction(s, a, params(tool), ports()).ok).toBe(false);
    }
    for (const status of ["suspended", "released"] as const)
      expect(
        beginHostOpsAction(
          {
            ...s,
            assignments: s.assignments.map((a) =>
              a.id === ops.id ? { ...a, status } : a,
            ),
          },
          caller,
          params(tool),
          ports(),
        ).ok,
      ).toBe(false);
    expect(
      beginHostOpsAction(
        {
          ...s,
          roles: s.roles.map((r) =>
            r.role_id === "host_ops" ? { ...r, allowed_tools: [] } : r,
          ),
        },
        caller,
        params(tool),
        ports(),
      ).ok,
    ).toBe(false);
    expect(JSON.stringify(s)).toBe(before);
  },
);

test.each(tools)(
  "%s checks all targets before creating any effects and records one actor-bound audit intent",
  (tool) => {
    const s = base(),
      io = ports();
    const before = JSON.stringify(s);
    expect(
      beginHostOpsAction(
        s,
        caller,
        { ...params(tool), target_id: id("assignment", 99) },
        io,
      ).ok,
    ).toBe(false);
    expect(
      beginHostOpsAction(s, caller, { ...params(tool), reason: " " }, io).ok,
    ).toBe(false);
    expect(
      beginHostOpsAction(
        { ...s, cards: s.cards.map((c) => ({ ...c, project_id: "other" })) },
        caller,
        { ...params("host_ops_restart_assignment") },
        io,
      ).ok,
    ).toBe(false);
    const effect = value(beginHostOpsAction(s, caller, params(tool), io));
    expect(effect.changes).toEqual([]);
    expect(effect.events).toHaveLength(1);
    expect(effect.events[0]).toMatchObject({
      type: "host_ops_action_taken",
      actor: caller,
      payload: {
        tool,
        target_id: params(tool).target_id,
        reason: params(tool).reason,
      },
    });
    expect(JSON.stringify(s)).toBe(before);
    const pending = apply(s, effect);
    expect(beginHostOpsAction(pending, caller, params(tool), io).ok).toBe(
      false,
    );
    const finished = value(
      finishHostOpsAction(
        pending,
        { kind: "system", project_id: s.project_id },
        effect.data.action_id,
        io,
      ),
    );
    const result = apply(pending, finished);
    expect(hostOpsPending(result.events, effect.data.assignment_id)).toBe(
      false,
    );
    expect(finished.data.run?.status).toBe(
      tool === "host_ops_cancel_run" ? undefined : "queued",
    );
    expect(result.runs.find((r) => r.id === id("run", 1))?.status).toBe(
      tool === "host_ops_restart_standing_pm" ? "running" : "cancelled",
    );
  },
);

test("restart rejects external, wrong standing target, finished Run and competing stop without effects", () => {
  const s = base(),
    p = params("host_ops_restart_assignment");
  expect(
    beginHostOpsAction(
      s,
      caller,
      { ...params("host_ops_restart_standing_pm"), target_id: ops.id },
      ports(),
    ).ok,
  ).toBe(false);
  expect(
    beginHostOpsAction(
      s,
      caller,
      {
        ...params("host_ops_restart_standing_pm"),
        target_id: id("assignment", 1),
      },
      ports(),
    ).ok,
  ).toBe(false);
  expect(
    beginHostOpsAction(
      { ...s, runs: s.runs.map((r) => ({ ...r, status: "completed" })) },
      caller,
      params("host_ops_cancel_run"),
      ports(),
    ).ok,
  ).toBe(false);
  const external = {
    ...s,
    assignments: s.assignments.map((a) =>
      a.id === p.target_id ? { ...a, external: true } : a,
    ),
  };
  expect(prepareHostOpsAction(external, caller, p).ok).toBe(false);
  expect(
    beginHostOpsAction(s, caller, { ...p, snapshot: undefined }, ports()).ok,
  ).toBe(false);
});

test.each(["done", "cancelled"] as const)(
  "C-217: closed %s cards allow audited cancellation and PM Ops release, but never restart or requeue",
  (status) => {
    const s: CommandState = {
      ...base(),
      cards: base().cards.map((c) => ({ ...c, status })),
      assignments: base().assignments.map((a) =>
        a.scope === "standing" && a.id === id("assignment", 4)
          ? { ...a, standing_mode: "ops" }
          : a,
      ),
    };
    const io = ports();
    const pm = actor(4, "pm");
    const pmOps = {
      ...pm,
      allowed_tools: role("pm").allowed_tools.filter(
        (t) => t !== "record_decision",
      ),
    };
    const release = (state: CommandState) =>
      releaseAssignment(
        state,
        pmOps,
        { assignment_id: id("assignment", 1) },
        io,
      );
    expect(release(s).ok).toBe(false);
    expect(
      prepareHostOpsAction(s, caller, params("host_ops_restart_assignment")),
    ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
    expect(
      beginHostOpsAction(s, caller, params("host_ops_restart_assignment"), io)
        .ok,
    ).toBe(false);
    const request = value(
      beginHostOpsAction(s, caller, params("host_ops_cancel_run"), io),
    );
    expect(request.events[0]).toMatchObject({
      type: "host_ops_action_taken",
      actor: caller,
      payload: { tool: "host_ops_cancel_run", target_id: id("run", 1) },
    });
    const pending = apply(s, request);
    expect(release(pending).ok).toBe(false);
    const finish = value(
      finishHostOpsAction(
        pending,
        { kind: "system", project_id: s.project_id },
        request.data.action_id,
        io,
      ),
    );
    const stopped = apply(pending, finish);
    expect(finish.data.run).toBeUndefined();
    expect(stopped.runs).toHaveLength(s.runs.length);
    expect(stopped.runs.find((r) => r.id === id("run", 1))).toMatchObject({
      status: "cancelled",
      outcome: "failed",
    });
    expect(finish.events.map((e) => e.type)).toEqual([
      "run_dispatch_aborted",
      "host_ops_action_finished",
    ]);
    expect(
      queueRun(
        stopped,
        human,
        { ...snapshot, assignment_id: id("assignment", 1) },
        io,
      ),
    ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
    expect(value(release(stopped)).data.status).toBe("released");
    expect(
      releaseAssignment(stopped, pmOps, { assignment_id: ops.id }, io).ok,
    ).toBe(false);
    expect(
      beginHostOpsAction(
        { ...s, cards: s.cards.map((c) => ({ ...c, project_id: "other" })) },
        caller,
        params("host_ops_cancel_run"),
        io,
      ),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  },
);

test("an accepted stop fences ACK, launch and competing human stop until host settlement", () => {
  const s = base(),
    io = ports(),
    p = params("host_ops_restart_assignment");
  const effect = value(beginHostOpsAction(s, caller, p, io)),
    pending = apply(s, effect);
  expect(
    acknowledgeRun(pending, actor(), { run_id: id("run", 1) }, io).ok,
  ).toBe(false);
  expect(
    queueRun(
      pending,
      human,
      { ...snapshot, assignment_id: id("assignment", 1) },
      io,
    ).ok,
  ).toBe(false);
  expect(
    abortDispatch(
      pending,
      human,
      { run_id: id("run", 1), reason: "competing" },
      io,
    ).ok,
  ).toBe(false);
  expect(
    finishHostOpsAction(pending, caller, effect.data.action_id, io).ok,
  ).toBe(false);
  const closed = {
    ...pending,
    cards: pending.cards.map((c) => ({ ...c, status: "cancelled" as const })),
  };
  expect(
    value(
      finishHostOpsAction(
        closed,
        { kind: "system", project_id: s.project_id },
        effect.data.action_id,
        io,
      ),
    ).data.run,
  ).toBeUndefined();
});

test("C-111: abort_dispatch and pause_standing_assignment reject every assignment actor, including fully permitted host_ops", () => {
  const s = base(),
    io = ports();
  const before = JSON.stringify(s);
  for (const a of [
    caller,
    { ...caller, allowed_tools: [...HOST_OPS_ROLE_TOOLS] },
    actor(4, "pm"),
    actor(1),
    actor(2, "reviewer"),
    { ...caller, project_id: "other" },
  ]) {
    expect(
      pauseStandingAssignment(s, a, { assignment_id: id("assignment", 4) }, io),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect(
      abortDispatch(s, a, { run_id: id("run", 1), reason: "stop" }, io),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  }
  expect(JSON.stringify(s)).toBe(before);
  // Human keeps both commands; the system host keeps abort_dispatch.
  const system = { kind: "system", project_id: s.project_id } as const;
  for (const a of [human, system]) {
    const aborted = value(
      abortDispatch(s, a, { run_id: id("run", 1), reason: "stop" }, io),
    );
    expect(aborted.data.status).toBe("cancelled");
    expect(aborted.events.some((e) => e.type === "host_ops_action_taken")).toBe(
      false,
    );
  }
  const paused = value(
    pauseStandingAssignment(
      s,
      human,
      { assignment_id: id("assignment", 4) },
      io,
    ),
  );
  expect(paused.data.assignment.status).toBe("suspended");
  expect(paused.events.some((e) => e.type === "host_ops_action_taken")).toBe(
    false,
  );
  expect(hostOpsReadDiagnostics(s, caller).ok).toBe(true);
  expect(hostOpsReadDiagnostics(s, actor(4, "pm")).ok).toBe(false);
});

test.each(["host_ops_cancel_run", "host_ops_restart_standing_pm"] as const)(
  "C-111 regression: %s still settles through the vetted host_ops action flow",
  (tool) => {
    const s = base(),
      io = ports();
    const begun = value(beginHostOpsAction(s, caller, params(tool), io));
    expect(begun.events).toEqual([
      expect.objectContaining({
        type: "host_ops_action_taken",
        actor: caller,
        payload: expect.objectContaining({ tool }),
      }),
    ]);
    const pending = apply(s, begun);
    const finished = value(
      finishHostOpsAction(
        pending,
        { kind: "system", project_id: s.project_id },
        begun.data.action_id,
        io,
      ),
    );
    const result = apply(pending, finished);
    expect(hostOpsPending(result.events, begun.data.assignment_id)).toBe(false);
    if (tool === "host_ops_cancel_run") {
      expect(finished.data.run).toBeUndefined();
      expect(result.runs.find((r) => r.id === id("run", 1))).toMatchObject({
        status: "cancelled",
        summary: params(tool).reason,
      });
    } else {
      expect(finished.data.run).toMatchObject({
        status: "queued",
        assignment_id: id("assignment", 4),
      });
      expect(
        result.assignments.find((a) => a.id === id("assignment", 4))?.status,
      ).toBe("active");
      // C-154: the same Assignment gets a fresh session; it is never paused,
      // so nothing it owns is handed to the human.
      expect(result.events.some((e) => e.type === "assignment_paused")).toBe(
        false,
      );
      expect(
        result.events.filter((e) => e.type === "standing_session_restarted"),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            assignment_id: id("assignment", 4),
          }),
        }),
      ]);
    }
  },
);

test("preflight refuses a conflicting pending worktree stop and an invalid launch profile before effects", () => {
  const original = base(),
    io = ports();
  const s: CommandState = {
    ...original,
    runs: [],
    assignments: original.assignments.map((a) =>
      a.scope === "work_item" ? { ...a, worktree_path: "/fixture/shared" } : a,
    ),
  };
  const p = params("host_ops_restart_assignment");
  const first = value(beginHostOpsAction(s, caller, p, io));
  const pending = apply(s, first);
  expect(
    beginHostOpsAction(
      pending,
      caller,
      { ...p, target_id: id("assignment", 2) },
      io,
    ).ok,
  ).toBe(false);
  expect(
    queueRun(
      pending,
      human,
      { ...snapshot, assignment_id: id("assignment", 2) },
      io,
    ).ok,
  ).toBe(false);
  expect(
    beginHostOpsAction(
      s,
      caller,
      { ...p, snapshot: { ...snapshot, launch_profile_ref: "" } },
      io,
    ).ok,
  ).toBe(false);
  const settled = value(
    finishHostOpsAction(
      pending,
      { kind: "system", project_id: s.project_id },
      first.data.action_id,
      io,
    ),
  );
  expect(settled.data.run?.status).toBe("queued");
});

test.each(["actor", "assignment", "replacement", "source", "cycle"])(
  "restart provenance rejects a broken %s binding",
  (broken) => {
    const io = ports(),
      source = base();
    const conflict = {
      id: io.ids.nextEventId(),
      card_id: id("card", 1),
      seq: 1,
      type: "merge_conflicted",
      actor: { kind: "system" as const, project_id: source.project_id },
      payload: { work_item_id: id("work_item", 1) },
      created_at: now,
    };
    const initial: CommandState = {
      ...source,
      events: [conflict],
      runs: source.runs.map((r) =>
        r.id === id("run", 1)
          ? { ...r, kind: "fix", trigger_event_id: conflict.id }
          : r,
      ),
    };
    const intent = value(
      beginHostOpsAction(
        initial,
        caller,
        params("host_ops_restart_assignment"),
        io,
      ),
    );
    const pending = apply(initial, intent);
    const finish = value(
      finishHostOpsAction(pending, conflict.actor, intent.data.action_id, io),
    );
    const state = apply(pending, finish),
      replacement = finish.data.run;
    if (!replacement) throw new Error("Missing replacement Run");
    const item = state.work_items.find((w) => w.id === id("work_item", 1));
    if (!item) throw new Error("Missing work item");
    const read = (s: CommandState) =>
      conflictRepairEvent(
        new CommandDraft(s, conflict.actor, "manage_host_ops_action", io),
        item,
        replacement,
        false,
      );
    expect(read(state)).toBe(conflict.id);
    const invalid: CommandState = {
      ...state,
      events: state.events.map((e) =>
        e.id !== finish.data.event.id
          ? e
          : {
              ...e,
              actor: broken === "actor" ? human : e.actor,
              payload: {
                ...(e.payload as Record<string, string>),
                ...(broken === "assignment"
                  ? { assignment_id: id("assignment", 2) }
                  : {}),
                ...(broken === "replacement" ? { run_id: id("run", 999) } : {}),
                ...(broken === "source"
                  ? { original_trigger_event_id: io.ids.nextEventId() }
                  : {}),
                ...(broken === "cycle"
                  ? {
                      previous_run_id: replacement.id,
                      original_trigger_event_id: finish.data.event.id,
                    }
                  : {}),
              },
            },
      ),
    };
    expect(read(invalid)).toBeUndefined();
  },
);

test("host restarts validate launch settings before intent and retain the host snapshot", () => {
  const s = base(),
    io = ports(),
    p = params("host_ops_restart_assignment");
  for (const settings of [{ harness: "unsupported" }, { effort: " " }]) {
    const result = beginHostOpsAction(
      s,
      caller,
      { ...p, snapshot: { ...snapshot, ...(settings as object) } },
      io,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
    expect(s.events).toEqual([]);
  }
  const configured = { ...snapshot, harness: "codex" as const, effort: "high" };
  const intent = value(
    beginHostOpsAction(s, caller, { ...p, snapshot: configured }, io),
  );
  expect(intent.events[0]).toMatchObject({ payload: { snapshot: configured } });
  const settled = value(
    finishHostOpsAction(
      apply(s, intent),
      { kind: "system", project_id: s.project_id },
      intent.data.action_id,
      io,
    ),
  );
  expect(settled.data.run).toMatchObject({
    status: "queued",
    harness: "codex",
    effort: "high",
  });
});

test.each([2, 3])(
  "invariants 11, 14: verifier A-%i needs a current target before restart and cannot requeue after withdrawal",
  (n) => {
    const s = base(),
      io = ports(),
      owner = id("assignment", n),
      system = { kind: "system" as const, project_id: s.project_id };
    const p = { ...params("host_ops_restart_assignment"), target_id: owner };
    const before = JSON.stringify(s);
    expect(prepareHostOpsAction(s, caller, p)).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
    expect(beginHostOpsAction(s, caller, p, io)).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
    expect(JSON.stringify(s)).toBe(before);
    // A missing review target must not prevent an explicit cancellation.
    expect(
      beginHostOpsAction(
        s,
        caller,
        { ...params("host_ops_cancel_run"), target_id: id("run", n) },
        io,
      ).ok,
    ).toBe(true);
    const delivery: Delivery = {
      id: id("delivery", 1),
      work_item_id: id("work_item", 1),
      run_id: id("run", 1),
      kind: n === 2 ? "code" : "card_completion",
      ...((n === 2 ? "code" : "card_completion") === "card_completion"
        ? { plain_summary: TEST_PLAIN_SUMMARY }
        : {}),
      summary: "Review target",
      subject,
      status: "accepted",
      requested_verifiers: [id("work_item", n)],
      attachments: [],
      known_gaps: [],
      evidence: [],
    };
    const ready = { ...s, deliveries: [delivery] };
    const intent = value(beginHostOpsAction(ready, caller, p, io));
    const pending = apply(ready, intent);
    expect(
      value(finishHostOpsAction(pending, system, intent.data.action_id, io))
        .data.run?.status,
    ).toBe("queued");
    const withdrawn: CommandState = {
      ...pending,
      deliveries: [{ ...delivery, status: "superseded" }],
    };
    const finished = value(
      finishHostOpsAction(withdrawn, system, intent.data.action_id, io),
    );
    expect(finished.data.run).toBeUndefined();
    const settled = apply(withdrawn, finished);
    expect(hostOpsPending(settled.events, owner)).toBe(false);
    expect(settled.runs.find((r) => r.id === id("run", n))?.status).toBe(
      "cancelled",
    );
    expect(settled.runs.filter((r) => r.assignment_id === owner)).toHaveLength(
      1,
    );
    expect(
      queueRun(settled, human, { ...snapshot, assignment_id: owner }, io).ok,
    ).toBe(false);
    const restored = {
      ...settled,
      deliveries: [
        ...settled.deliveries,
        { ...delivery, id: id("delivery", 2) },
      ],
    };
    expect(
      value(
        queueRun(restored, human, { ...snapshot, assignment_id: owner }, io),
      ).data.status,
    ).toBe("queued");
  },
);

test("C-152: exit confirmation for a foreign terminal is system-requested, human-confirmed and closed on settlement", () => {
  const s = base(),
    io = ports(),
    system = { kind: "system" as const, project_id: s.project_id };
  const begun = value(
    beginHostOpsAction(s, caller, params("host_ops_restart_assignment"), io),
  );
  let state = apply(s, begun);
  const action = begun.data.action_id;
  const request = {
    action_id: action,
    instructions: "1. check\n2. kill\n3. recheck\n4. confirm",
    why_human: "foreign runtime",
  };
  expect(hostOpsExitConfirmation(state, action)).toEqual({ status: "none" });
  // Only the host's system flow may ask; agents and humans cannot.
  for (const a of [human, caller])
    expect(requestHostOpsExitConfirmation(state, a, request, io).ok).toBe(
      false,
    );
  expect(
    requestHostOpsExitConfirmation(
      state,
      system,
      { ...request, instructions: " " },
      io,
    ).ok,
  ).toBe(false);
  const asked = value(
    requestHostOpsExitConfirmation(state, system, request, io),
  );
  expect(asked.data.created).toBe(true);
  expect(asked.events).toEqual([
    expect.objectContaining({
      type: "human_action_requested",
      payload: expect.objectContaining({
        host_ops_action_id: action,
        human_action_id: asked.data.human_action_id,
      }),
    }),
  ]);
  state = apply(state, asked);
  const open = {
    status: "open",
    human_action_id: asked.data.human_action_id,
  };
  expect(hostOpsExitConfirmation(state, action)).toEqual(open);
  // Even a reclassified handoff cannot turn an exit fence into an ordinary host check.
  const delegated: typeof state = {
    ...state,
    assignments: state.assignments.map((a) =>
      a.id === id("assignment", 4) && a.scope === "standing"
        ? { ...a, standing_mode: "office", external: true }
        : a,
    ),
    human_actions: state.human_actions.map((h) =>
      h.id === asked.data.human_action_id
        ? {
            ...h,
            triage: "host",
            host_operator: "external",
            host_assignment_id: id("assignment", 4),
            category: "general",
          }
        : h,
    ),
  };
  expect(
    completeHumanAction(
      delegated,
      actor(4, "pm"),
      { human_action_id: asked.data.human_action_id, text: "checked" },
      io,
    ).ok,
  ).toBe(false);
  // Idempotent while open: no second Needs You item.
  const again = value(
    requestHostOpsExitConfirmation(state, system, request, io),
  );
  expect(again.data).toEqual({
    human_action_id: asked.data.human_action_id,
    created: false,
  });
  expect(again.events).toEqual([]);

  // A non-human completion (e.g. PM triage) is not a confirmation.
  const byAgent = {
    ...state,
    human_actions: state.human_actions.map((h) =>
      h.id === asked.data.human_action_id
        ? { ...h, status: "done" as const }
        : h,
    ),
    events: [
      ...state.events,
      {
        id: "E-pm" as never,
        seq: 999,
        type: "human_action_completed",
        actor: actor(4, "pm"),
        payload: { human_action_id: asked.data.human_action_id },
        created_at: now,
      },
    ],
  };
  expect(hostOpsExitConfirmation(byAgent, action).status).toBe("rejected");
  expect(
    value(requestHostOpsExitConfirmation(byAgent, system, request, io)).data
      .created,
  ).toBe(true);

  // Settling the action another way cancels the stale open request.
  const settled = value(finishHostOpsAction(state, system, action, io));
  expect(
    apply(state, settled).human_actions.find(
      (h) => h.id === asked.data.human_action_id,
    )?.status,
  ).toBe("cancelled");

  const confirmed = apply(
    state,
    value(
      completeHumanAction(
        state,
        human,
        { human_action_id: asked.data.human_action_id, text: "exited" },
        io,
      ),
    ),
  );
  expect(hostOpsExitConfirmation(confirmed, action)).toEqual({
    ...open,
    status: "confirmed",
  });
  expect(
    requestHostOpsExitConfirmation(
      apply(
        confirmed,
        value(finishHostOpsAction(confirmed, system, action, io)),
      ),
      system,
      request,
      io,
    ).ok,
  ).toBe(false);
});

test("C-137: diagnostics domain view carries only Run and host action state", () => {
  const data = value(hostOpsReadDiagnostics(base(), caller)).data;
  expect(Object.keys(data).sort()).toEqual(["actions", "runs"]);
});

test("hold during an in-flight restart allows exit settlement without queueing new work", () => {
  const s = base(),
    io = ports();
  const begun = value(
    beginHostOpsAction(s, caller, params("host_ops_restart_assignment"), io),
  );
  const pending = apply(s, begun);
  const held = {
    ...pending,
    cards: pending.cards.map((c) => ({
      ...c,
      hold: {
        reason: "wait",
        resume_condition: "ready",
        set_by: "human" as const,
        set_at: now,
      },
    })),
  };
  const settled = value(
    finishHostOpsAction(
      held,
      { kind: "system", project_id: s.project_id },
      begun.data.action_id,
      io,
    ),
  );
  expect(settled.data.run).toBeUndefined();
  expect(hostOpsPending(apply(held, settled).events, id("assignment", 1))).toBe(
    false,
  );
  expect(
    apply(held, settled).runs.find((r) => r.id === id("run", 1))?.status,
  ).toBe("cancelled");
});
