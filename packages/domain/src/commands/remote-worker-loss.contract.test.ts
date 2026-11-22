import { expect, test } from "vitest";
import {
  acknowledgeRun,
  assign,
  cancelHumanAction,
  completeHumanAction,
  dispatchRun,
  finishRun,
  hostOpsPending,
  queueRun,
  refreshCancelledHumanActions,
  releaseAssignment,
  releaseLostRemoteWorker,
  reportRemoteWorkerAlive,
  requestRemoteWorkerExit,
  triageHumanAction,
} from "../index.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  machine,
  now,
  ports,
  value,
} from "./test-fixtures.js";

const system = { kind: "system" as const, project_id: human.project_id };
const owner = id("assignment", 1);
const backup = { sha: "a".repeat(40), at: now, branch: "agent/C-1/W-1" };
function setup(started = true) {
  const original = fixture();
  const state = {
    ...original,
    machines: [machine(), { ...machine(), id: "worker-a" }],
    assignments: original.assignments.map((a) =>
      a.id === owner
        ? {
            ...a,
            machine_id: "worker-a",
            runtime_state: "lost" as const,
            branch: backup.branch,
            runtime_ref: {
              machine_id: "worker-a",
              runtime_machine: "worker-a",
              terminal_ref: "old-terminal",
              agent_name: "old-agent",
            },
          }
        : a,
    ),
    runs: original.runs.map((r) =>
      r.assignment_id === owner
        ? {
            ...r,
            status: "unknown" as const,
            ...(started ? { started_at: now } : {}),
          }
        : r,
    ),
  };
  const io = ports();
  const request = value(
    requestRemoteWorkerExit(
      state,
      system,
      { assignment_id: owner, backup },
      io,
    ),
  );
  let current = apply(state, request);
  const action = current.human_actions[0];
  if (!action) throw new Error("Missing confirmation");
  const confirm = () => {
    current = apply(
      current,
      value(
        completeHumanAction(
          current,
          human,
          {
            human_action_id: action.id,
            conclusion: "exited",
            text: "Machine powered off",
          },
          io,
        ),
      ),
    );
    return current;
  };
  const release = () => {
    current = apply(
      current,
      value(
        releaseLostRemoteWorker(current, system, request.data.action_id, io),
      ),
    );
    return current;
  };
  return { state, request, current, action, io, confirm, release };
}

test("lost remote workers preserve execution and fence all restart/release paths until a human confirms", () => {
  const f = setup();
  expect(f.current.assignments).toEqual(f.state.assignments);
  expect(f.current.runs).toEqual(f.state.runs);
  expect(f.action.instructions).toContain(backup.sha);
  expect(f.action.instructions).toContain(backup.at);
  expect(f.action.instructions).toContain("worker-a");
  expect(f.action.instructions).toContain(owner);
  expect(hostOpsPending(f.current.events, owner)).toBe(true);
  expect(
    value(
      requestRemoteWorkerExit(
        f.current,
        system,
        { assignment_id: owner },
        f.io,
      ),
    ).events,
  ).toEqual([]);
  for (const caller of [human, actor(), actor(4, "pm")])
    expect(
      requestRemoteWorkerExit(f.state, caller, { assignment_id: owner }, f.io)
        .ok,
    ).toBe(false);
  expect(
    releaseLostRemoteWorker(f.current, system, f.request.data.action_id, f.io)
      .ok,
  ).toBe(false);
  expect(
    releaseAssignment(f.current, human, { assignment_id: owner }, f.io).ok,
  ).toBe(false);
  expect(
    queueRun(
      f.current,
      human,
      { assignment_id: owner, model: "fixture", agent_cli_version: "fixture" },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    assign(
      f.current,
      human,
      {
        work_item_id: id("work_item", 1),
        role_id: "coder",
        machine_id: "local",
        recovery_source: "main",
      },
      f.io,
    ).ok,
  ).toBe(false);
});

test("Assignment tokens cannot confirm or delegate the remote exit, even through host completion", () => {
  const f = setup();
  for (const caller of [actor(), actor(4, "pm"), system]) {
    expect(
      completeHumanAction(
        f.current,
        caller,
        { human_action_id: f.action.id, conclusion: "exited", text: "done" },
        f.io,
      ).ok,
    ).toBe(false);
    expect(
      triageHumanAction(
        f.current,
        caller,
        {
          human_action_id: f.action.id,
          disposition: "done",
          rationale: "done",
        },
        f.io,
      ).ok,
    ).toBe(false);
  }
  expect(
    triageHumanAction(
      f.current,
      human,
      {
        human_action_id: f.action.id,
        disposition: "host",
        rationale: "delegate",
      },
      f.io,
    ).ok,
  ).toBe(false);
});

test.each(["main", "backup"] as const)(
  "human exit allows exactly one explicit %s reassignment without erasing old author history",
  (source) => {
    const f = setup();
    f.confirm();
    const released = f.release();
    expect(released.assignments.find((a) => a.id === owner)).toMatchObject({
      status: "released",
      runtime_state: "released",
      runtime_ref: null,
    });
    expect(released.runs.find((r) => r.assignment_id === owner)).toMatchObject({
      status: "cancelled",
      outcome: "failed",
    });
    expect(released.work_items).toEqual(f.state.work_items);
    expect(
      value(
        releaseLostRemoteWorker(
          released,
          system,
          f.request.data.action_id,
          f.io,
        ),
      ).events,
    ).toEqual([]);
    const params = {
      work_item_id: id("work_item", 1),
      role_id: "coder",
      machine_id: "local",
    };
    expect(assign(released, human, params, f.io).ok).toBe(false);
    expect(
      assign(
        released,
        human,
        { ...params, recovery_source: source, machine_id: "worker-a" },
        f.io,
      ).ok,
    ).toBe(false);
    const reassigned = value(
      assign(released, human, { ...params, recovery_source: source }, f.io),
    );
    expect(reassigned.data.recovery).toEqual({
      previous_assignment_id: owner,
      source,
      ...(source === "backup" ? { backup } : {}),
    });
    const current = apply(released, reassigned);
    expect(
      current.assignments.filter((a) => a.work_item_id === params.work_item_id),
    ).toHaveLength(2);
    expect(value(assign(current, human, params, f.io)).data.id).toBe(
      reassigned.data.id,
    );
    expect(value(assign(current, human, params, f.io)).token_requests).toEqual(
      [],
    );
    expect(
      finishRun(
        current,
        actor(),
        { run_id: id("run", 1), outcome: "completed", summary: "late" },
        f.io,
      ).ok,
    ).toBe(false);
  },
);

const sameMachine = {
  work_item_id: id("work_item", 1),
  role_id: "coder",
  machine_id: "worker-a",
  recovery_source: "main" as const,
  confirm_same_machine: true,
};

test.each([
  ["main", human, "human"],
  ["backup", actor(4, "pm"), "assignment:A-4"],
] as const)(
  "one worker: confirmed %s recovery creates and starts one audited successor",
  (source, caller, confirmedBy) => {
    const f = setup();
    f.confirm();
    const released = {
      ...f.release(),
      machines: [{ ...machine(), id: "worker-a" }],
    };
    const params = { ...sameMachine, recovery_source: source };
    const next = value(assign(released, caller, params, f.io));
    const recovery = {
      previous_assignment_id: owner,
      source,
      same_machine_confirmed_by: confirmedBy,
      ...(source === "backup" ? { backup } : {}),
    };
    expect(next.data.id).not.toBe(owner);
    expect(next.data.recovery).toEqual(recovery);
    expect(next.events).toContainEqual(
      expect.objectContaining({
        type: "work_item_assigned",
        actor: caller,
        payload: expect.objectContaining({
          assignment_id: next.data.id,
          machine_id: "worker-a",
          recovery,
        }),
      }),
    );
    const current = apply(released, next);
    expect(value(assign(current, caller, params, f.io))).toMatchObject({
      data: { id: next.data.id },
      events: [],
      token_requests: [],
    });
    const queued = value(
      queueRun(
        current,
        system,
        {
          assignment_id: next.data.id,
          model: "fixture",
          agent_cli_version: "fixture",
        },
        f.io,
      ),
    );
    const queuedState = apply(current, queued);
    const dispatched = value(
      dispatchRun(
        queuedState,
        system,
        {
          run_id: queued.data.id,
          runtime_ref: {
            machine_id: "worker-a",
            runtime_machine: "worker-a",
            terminal_ref: "new-terminal",
            agent_name: "successor",
          },
        },
        f.io,
      ),
    );
    const started = value(
      acknowledgeRun(
        apply(queuedState, dispatched),
        actor(Number(next.data.id.slice(2)), "coder"),
        { run_id: queued.data.id },
        f.io,
      ),
    );
    expect(started.events).toContainEqual(
      expect.objectContaining({
        type: "run_started",
        payload: { assignment_id: next.data.id, run_id: queued.data.id },
      }),
    );
  },
);

test("same-machine confirmation is neither exit evidence nor permission and cannot choose a machine or source implicitly", () => {
  const f = setup();
  const rejected = (
    state: typeof f.current,
    params: Parameters<typeof assign>[2],
    caller = human,
  ) => expect(assign(state, caller, params, f.io).ok).toBe(false);
  rejected(f.current, sameMachine);
  rejected(f.confirm(), sameMachine); // not released yet
  const released = f.release();
  const { machine_id: _machine, ...noMachine } = sameMachine;
  const { recovery_source: _source, ...noSource } = sameMachine;
  rejected(released, noMachine);
  rejected(released, noSource);
  rejected(released, { ...sameMachine, machine_id: "local" });
  rejected(released, { ...sameMachine, confirm_same_machine: false });
  rejected(released, sameMachine, actor(2, "reviewer"));
  const pm = actor(4, "pm");
  if (pm.kind !== "assignment") throw new Error("Missing PM identity");
  rejected(released, sameMachine, { ...pm, allowed_tools: [] });
  rejected(released, sameMachine, system);
  const late = value(
    reportRemoteWorkerAlive(released, system, f.request.data.action_id, f.io),
  );
  rejected(apply(released, late), sameMachine);
});

test("normal release cannot authorize reassignment; changed runtime cannot consume confirmation", () => {
  const f = setup();
  const confirmed = f.confirm();
  const changed = {
    ...confirmed,
    assignments: confirmed.assignments.map((a) =>
      a.id === owner ? { ...a, runtime_ref: null } : a,
    ),
  };
  expect(
    releaseLostRemoteWorker(changed, system, f.request.data.action_id, f.io).ok,
  ).toBe(false);
  const released = f.release();
  expect(
    assign(
      { ...released, events: [] },
      human,
      {
        work_item_id: id("work_item", 1),
        role_id: "coder",
        machine_id: "local",
        recovery_source: "main",
      },
      f.io,
    ).ok,
  ).toBe(false);
});

test("cancelled confirmation never releases; card cancellation retains the exit request for safe settlement", () => {
  const f = setup();
  const cancelled = apply(
    f.current,
    value(
      cancelHumanAction(
        f.current,
        human,
        { human_action_id: f.action.id, reason: "later" },
        f.io,
      ),
    ),
  );
  expect(
    releaseLostRemoteWorker(cancelled, system, f.request.data.action_id, f.io)
      .ok,
  ).toBe(false);
  expect(
    value(
      requestRemoteWorkerExit(
        cancelled,
        system,
        { assignment_id: owner },
        f.io,
      ),
    ).events,
  ).toHaveLength(1);
  const closed = {
    ...f.current,
    cards: f.current.cards.map((c) => ({ ...c, status: "cancelled" as const })),
  };
  expect(
    value(refreshCancelledHumanActions(closed, system, f.io)).events,
  ).toEqual([]);
  const confirmed = apply(
    closed,
    value(
      completeHumanAction(
        closed,
        human,
        { human_action_id: f.action.id, conclusion: "exited", text: "exited" },
        f.io,
      ),
    ),
  );
  expect(
    releaseLostRemoteWorker(confirmed, system, f.request.data.action_id, f.io)
      .ok,
  ).toBe(true);
});

test("verified alive withdraws an open H; after release it fences the orphan without another H", () => {
  const f = setup();
  const observed = value(
    reportRemoteWorkerAlive(f.current, system, f.request.data.action_id, f.io),
  );
  const corrected = apply(f.current, observed);
  expect(corrected.human_actions[0]?.status).toBe("cancelled");
  expect(corrected.assignments.find((a) => a.id === owner)?.runtime_state).toBe(
    "running",
  );
  expect(hostOpsPending(corrected.events, owner)).toBe(false);
  f.confirm();
  const released = f.release();
  const late = value(
    reportRemoteWorkerAlive(released, system, f.request.data.action_id, f.io),
  );
  expect(late.changes.every((c) => c.collection === "human_actions")).toBe(
    true,
  );
  expect(late.changes).toHaveLength(0);
  expect(
    value(
      reportRemoteWorkerAlive(
        apply(released, late),
        system,
        f.request.data.action_id,
        f.io,
      ),
    ).events,
  ).toEqual([]);
});

test("alive arriving after human confirmation invalidates it before release or another dispatch", () => {
  const f = setup();
  const confirmed = f.confirm();
  const alive = apply(
    confirmed,
    value(
      reportRemoteWorkerAlive(
        confirmed,
        system,
        f.request.data.action_id,
        f.io,
      ),
    ),
  );
  expect(
    releaseLostRemoteWorker(alive, system, f.request.data.action_id, f.io).ok,
  ).toBe(false);
  const released = f.release();
  const next = value(
    assign(
      released,
      human,
      {
        work_item_id: id("work_item", 1),
        role_id: "coder",
        machine_id: "local",
        recovery_source: "main",
      },
      f.io,
    ),
  );
  const assigned = apply(released, next);
  const late = apply(
    assigned,
    value(
      reportRemoteWorkerAlive(assigned, system, f.request.data.action_id, f.io),
    ),
  );
  expect(hostOpsPending(late.events, next.data.id)).toBe(true);
  expect(
    queueRun(
      late,
      human,
      {
        assignment_id: next.data.id,
        model: "fixture",
        agent_cli_version: "fixture",
      },
      f.io,
    ).ok,
  ).toBe(false);
});

test("a later legacy human exit confirmation resolves only its matching post-release sighting", () => {
  const f = setup();
  f.confirm();
  const released = f.release();
  const next = value(
    assign(
      released,
      human,
      {
        work_item_id: id("work_item", 1),
        role_id: "coder",
        machine_id: "local",
        recovery_source: "main",
      },
      f.io,
    ),
  );
  const state = apply(released, next);
  const alive = apply(
    state,
    value(
      reportRemoteWorkerAlive(state, system, f.request.data.action_id, f.io),
    ),
  );
  const opened = alive.events.find((e) => e.type === "human_action_requested");
  const done = alive.events.find((e) => e.type === "human_action_completed");
  if (!opened || !done) throw new Error("Missing exit confirmation");
  const H = id("human_action", 999);
  const legacy = [
    ...alive.events,
    {
      ...opened,
      id: f.io.ids.nextEventId(),
      payload: {
        host_ops_action_id: f.request.data.action_id,
        human_action_id: H,
        assignment_id: owner,
      },
    },
  ];
  const completed = {
    ...done,
    id: f.io.ids.nextEventId(),
    payload: { human_action_id: H },
  };
  expect(
    hostOpsPending([...legacy, { ...completed, actor: system }], next.data.id),
  ).toBe(true);
  expect(hostOpsPending([...legacy, done], next.data.id)).toBe(true);
  const confirmed = { ...alive, events: [...legacy, completed] };
  expect(hostOpsPending(confirmed.events, next.data.id)).toBe(false);
  const again = apply(
    confirmed,
    value(
      reportRemoteWorkerAlive(
        confirmed,
        system,
        f.request.data.action_id,
        f.io,
      ),
    ),
  );
  expect(hostOpsPending(again.events, next.data.id)).toBe(true);
  expect(again.assignments).toEqual(confirmed.assignments);
});

test("no backup cannot authorize a backup restore; pending finish is discarded during confirmed failure settlement", () => {
  const f = setup();
  const requested = value(
    requestRemoteWorkerExit(f.state, system, { assignment_id: owner }, f.io),
  );
  let state = apply(f.state, requested);
  const action = state.human_actions[0];
  const runtime = state.assignments.find((a) => a.id === owner)?.runtime_ref;
  if (!action || !runtime) throw new Error("Missing loss fixture");
  expect(action.instructions).toContain("没有成功备份记录");
  state = {
    ...state,
    runs: state.runs.map((r) =>
      r.assignment_id === owner
        ? {
            ...r,
            pending_finish: {
              outcome: "completed",
              summary: "late",
              token_id: "old-token",
              runtime_ref: runtime,
            },
          }
        : r,
    ),
  };
  state = apply(
    state,
    value(
      completeHumanAction(
        state,
        human,
        { human_action_id: action.id, conclusion: "exited", text: "exited" },
        f.io,
      ),
    ),
  );
  state = apply(
    state,
    value(
      releaseLostRemoteWorker(state, system, requested.data.action_id, f.io),
    ),
  );
  expect(
    state.runs.find((r) => r.assignment_id === owner)?.pending_finish,
  ).toBeUndefined();
  expect(
    assign(
      state,
      human,
      {
        work_item_id: id("work_item", 1),
        role_id: "coder",
        machine_id: "local",
        recovery_source: "backup",
      },
      f.io,
    ).ok,
  ).toBe(false);
});

test.each(["main", "backup"] as const)(
  "an earlier worker's pending exit blocks a third %s Assignment until the kernel confirms exit",
  (recovery_source) => {
    const f = setup();
    f.confirm();
    let state = f.release();
    state = {
      ...state,
      machines: [...(state.machines ?? []), { ...machine(), id: "worker-b" }],
    };
    const middle = value(
      assign(
        state,
        human,
        {
          work_item_id: id("work_item", 1),
          role_id: "coder",
          machine_id: "worker-b",
          recovery_source: "main",
        },
        f.io,
      ),
    );
    state = apply(state, middle);
    const secondBackup = {
      ...backup,
      sha: "b".repeat(40),
      branch: `${backup.branch}-${middle.data.id}`,
    };
    state = {
      ...state,
      assignments: state.assignments.map((a) =>
        a.id === middle.data.id
          ? {
              ...a,
              branch: secondBackup.branch,
              runtime_state: "lost" as const,
            }
          : a,
      ),
    };
    const loss = value(
      requestRemoteWorkerExit(
        state,
        system,
        { assignment_id: middle.data.id, backup: secondBackup },
        f.io,
      ),
    );
    state = apply(state, loss);
    const confirmation = state.human_actions.find((h) => h.status === "open");
    if (!confirmation) throw new Error("Missing second exit request");
    state = apply(
      state,
      value(
        completeHumanAction(
          state,
          human,
          {
            human_action_id: confirmation.id,
            conclusion: "exited",
            text: "Second worker stopped",
          },
          f.io,
        ),
      ),
    );
    state = apply(
      state,
      value(releaseLostRemoteWorker(state, system, loss.data.action_id, f.io)),
    );
    state = apply(
      state,
      value(
        reportRemoteWorkerAlive(state, system, f.request.data.action_id, f.io),
      ),
    );
    expect(hostOpsPending(state.events, middle.data.id)).toBe(true);
    const params = {
      work_item_id: id("work_item", 1),
      role_id: "coder",
      machine_id: "local",
      recovery_source,
    };
    expect(assign(state, human, params, f.io)).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
    expect(state.human_actions.filter((h) => h.status === "open")).toEqual([]);
    state = {
      ...state,
      events: [
        ...state.events,
        {
          id: f.io.ids.nextEventId(),
          seq: f.io.ids.nextEventSequence(state.project_id, undefined),
          actor: system,
          created_at: now,
          type: "remote_worker_exit_observed",
          payload: {
            action_id: f.request.data.action_id,
            assignment_id: owner,
          },
        },
      ],
    };
    const next = value(assign(state, human, params, f.io));
    expect(next.token_requests).toHaveLength(1);
    expect(next.data.recovery).toMatchObject({
      source: recovery_source,
      previous_assignment_id: middle.data.id,
    });
    const retry = value(assign(apply(state, next), human, params, f.io));
    expect(retry.data.id).toBe(next.data.id);
    expect(retry.token_requests).toEqual([]);
  },
);

test("a pre-launch failure after confirmed backup takeover retains the chosen commit on the next machine", () => {
  const f = setup();
  f.confirm();
  const released = f.release();
  const work_item_id = id("work_item", 1),
    card_id = id("card", 1);
  const s = {
    ...released,
    machines: [...(released.machines ?? []), { ...machine(), id: "worker-b" }],
  };
  const params = { work_item_id, role_id: "coder" };
  const takeover = value(
    assign(
      s,
      human,
      { ...params, machine_id: "worker-b", recovery_source: "backup" },
      f.io,
    ),
  );
  const assigned = apply(s, takeover);
  const failure = {
    type: "bell_delivery_failed",
    id: f.io.ids.nextEventId(),
    created_at: now,
    card_id,
    seq: f.io.ids.nextEventSequence(s.project_id, card_id),
    actor: system,
    payload: {
      assignment_id: takeover.data.id,
      reason: "snapshot_unavailable",
    },
  };
  const failed = { ...assigned, events: [...assigned.events, failure] };
  const ready = apply(
    failed,
    value(
      releaseAssignment(
        failed,
        human,
        { assignment_id: takeover.data.id },
        f.io,
      ),
    ),
  );
  expect(ready.work_items.find((w) => w.id === work_item_id)?.status).toBe(
    "in_progress",
  );
  // A prior confirmed loss elsewhere in the item's history is not a takeover chain.
  const unlinked = {
    ...ready,
    assignments: ready.assignments.map((a) =>
      a.id === takeover.data.id && a.recovery
        ? { ...a, recovery: { ...a.recovery, previous_assignment_id: a.id } }
        : a,
    ),
  };
  expect(assign(unlinked, human, params, f.io).ok).toBe(false);
  const late = apply(
    ready,
    value(
      reportRemoteWorkerAlive(ready, system, f.request.data.action_id, f.io),
    ),
  );
  expect(assign(late, human, params, f.io).ok).toBe(false);
  for (const status of [
    "accepted",
    "cancelled",
    "delivered",
    "waiting_decision",
    "blocked",
  ] as const) {
    const ineligible = {
      ...ready,
      work_items: ready.work_items.map((w) =>
        w.id === work_item_id && w.kind === "produce" ? { ...w, status } : w,
      ),
    };
    expect(assign(ineligible, human, params, f.io).ok).toBe(false);
  }
  const retry = value(assign(ready, human, params, f.io));
  expect(retry.data).toMatchObject({
    machine_id: "local",
    recovery: {
      previous_assignment_id: takeover.data.id,
      source: "backup",
      backup,
    },
  });
});

test("remote H requires an explicit conclusion; a false alarm never releases or replaces the owner", () => {
  const f = setup();
  const p = { human_action_id: f.action.id, text: "误报" };
  expect(completeHumanAction(f.current, human, p, f.io).ok).toBe(false);
  const state = apply(
    f.current,
    value(
      completeHumanAction(
        f.current,
        human,
        { ...p, conclusion: "false_alarm" },
        f.io,
      ),
    ),
  );
  expect(state.human_actions[0]?.result?.conclusion).toBe("false_alarm");
  expect(state.assignments.find((a) => a.id === owner)).toMatchObject({
    status: "active",
    runtime_state: "running",
    runtime_ref: f.state.assignments.find((a) => a.id === owner)?.runtime_ref,
  });
  expect(state.runs.find((r) => r.assignment_id === owner)?.status).toBe(
    "running",
  );
  expect(
    releaseLostRemoteWorker(state, system, f.request.data.action_id, f.io).ok,
  ).toBe(false);
});

test.each(["observer", "human"])(
  "a %s correction before first acknowledgement restores dispatch, not a start",
  (source) => {
    const f = setup(false);
    const before = {
      ...f.current,
      work_items: f.current.work_items.map((w) =>
        w.id === id("work_item", 1) ? { ...w, status: "ready" as const } : w,
      ),
    };
    const state =
      source === "observer"
        ? apply(
            before,
            value(
              reportRemoteWorkerAlive(
                before,
                system,
                f.request.data.action_id,
                f.io,
              ),
            ),
          )
        : apply(
            before,
            value(
              completeHumanAction(
                before,
                human,
                {
                  human_action_id: f.action.id,
                  conclusion: "false_alarm",
                  text: "核实仍在运行",
                },
                f.io,
              ),
            ),
          );
    const run = state.runs.find((r) => r.assignment_id === owner);
    if (!run) throw new Error("Missing Run");
    expect(run.status).toBe("dispatched");
    expect(run.started_at).toBeUndefined();
    const start = value(
      acknowledgeRun(state, actor(), { run_id: run.id }, f.io),
    );
    expect(start.data).toMatchObject({ status: "running", started_at: now });
    expect(
      apply(state, start).work_items.find((w) => w.id === id("work_item", 1))
        ?.status,
    ).toBe("in_progress");
    expect(start.events.filter((e) => e.type === "run_started")).toHaveLength(
      1,
    );
  },
);

test("an inconclusive human observation retains the same open fence until a definite answer", () => {
  const f = setup(),
    p = { human_action_id: f.action.id, text: "无法联系机器" };
  const state = apply(
    f.current,
    value(
      completeHumanAction(
        f.current,
        human,
        { ...p, conclusion: "unconfirmed" },
        f.io,
      ),
    ),
  );
  expect(
    state.human_actions.find((h) => h.id === p.human_action_id),
  ).toMatchObject({ status: "open", result: { conclusion: "unconfirmed" } });
  const later = { ...f.io, clock: { now: () => "2026-01-02T00:00:00.000Z" } };
  const repeat = value(
    completeHumanAction(
      state,
      human,
      { ...p, conclusion: "unconfirmed", attachments: [] },
      later,
    ),
  );
  expect(repeat).toMatchObject({
    changes: [],
    events: [],
    timeline: [],
    data: { result: { at: now } },
  });
  const updated = value(
    completeHumanAction(
      state,
      human,
      { ...p, conclusion: "unconfirmed", text: "复核仍无法联系" },
      later,
    ),
  );
  expect(
    updated.events.filter((e) => e.type === "remote_worker_exit_unconfirmed"),
  ).toHaveLength(1);
  expect(updated.data).toMatchObject({
    status: "open",
    result: { at: later.clock.now() },
  });
  for (const conclusion of ["false_alarm", "exited"] as const) {
    expect(
      value(
        completeHumanAction(
          apply(state, updated),
          human,
          { ...p, conclusion },
          later,
        ),
      ).data.status,
    ).toBe("done");
  }
  expect(state.runs).toEqual(f.current.runs);
  expect(hostOpsPending(state.events, owner)).toBe(true);
  expect(
    releaseLostRemoteWorker(state, system, f.request.data.action_id, f.io).ok,
  ).toBe(false);
  expect(
    completeHumanAction(state, human, { ...p, conclusion: "false_alarm" }, f.io)
      .ok,
  ).toBe(true);
});
