import { expect, test } from "vitest";
import {
  assign,
  cancelHumanAction,
  completeHumanAction,
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
function setup() {
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
      r.assignment_id === owner ? { ...r, status: "unknown" as const } : r,
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
          { human_action_id: action.id, text: "Machine powered off" },
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
        { human_action_id: f.action.id, text: "done" },
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
        { human_action_id: f.action.id, text: "exited" },
        f.io,
      ),
    ),
  );
  expect(
    releaseLostRemoteWorker(confirmed, system, f.request.data.action_id, f.io)
      .ok,
  ).toBe(true);
});

test("late alive never revives an old identity and asks the human again after release", () => {
  const f = setup();
  const observed = value(
    reportRemoteWorkerAlive(f.current, system, f.request.data.action_id, f.io),
  );
  expect(observed.changes).toEqual([]);
  f.confirm();
  const released = f.release();
  const late = value(
    reportRemoteWorkerAlive(released, system, f.request.data.action_id, f.io),
  );
  expect(late.changes.every((c) => c.collection === "human_actions")).toBe(
    true,
  );
  expect(late.changes).toHaveLength(1);
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
        { human_action_id: action.id, text: "exited" },
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

test("a cancelled late exit request can be renewed even after the old Assignment was released", () => {
  const f = setup();
  f.confirm();
  const released = f.release();
  const late = apply(
    released,
    value(
      reportRemoteWorkerAlive(released, system, f.request.data.action_id, f.io),
    ),
  );
  const action = late.human_actions.find((h) => h.status === "open");
  if (!action) throw new Error("Missing late confirmation");
  const cancelled = apply(
    late,
    value(
      cancelHumanAction(
        late,
        human,
        { human_action_id: action.id, reason: "later" },
        f.io,
      ),
    ),
  );
  const renewed = value(
    requestRemoteWorkerExit(cancelled, system, { assignment_id: owner }, f.io),
  );
  expect(renewed.events.map((e) => e.type)).toEqual(["human_action_requested"]);
  expect(renewed.changes.every((c) => c.collection === "human_actions")).toBe(
    true,
  );
});
