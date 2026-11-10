import { beforeEach, expect, test } from "vitest";
import {
  abortDispatch,
  acknowledgeRun,
  claimDispatchStop,
  claimInactiveRunStop,
  dispatchedAt,
  finishRun,
  type Notification,
  obsoleteDispatchAttention,
  occupiedRunSlots,
  type Run,
  recoverDispatch,
  releaseAssignment,
  resolveDispatchAttention,
  startDispatchStop,
} from "../index.js";
import { CommandDraft } from "./core.js";
import {
  actor,
  commit,
  dispatch,
  f,
  queue,
  setup,
  system,
} from "./launch/test-fixtures.js";
import { conflictRepairEvent } from "./review-round.js";

let run: Run;
let now: number;
beforeEach(() => {
  setup();
  now = Date.parse(f.io.clock.now());
  f.io = { ...f.io, clock: { now: () => new Date(now).toISOString() } };
  run = commit(dispatch(commit(queue())));
});

test("dispatch stop reserves capacity and excludes launches until unknown Run recovery settles", () => {
  now += 600000;
  const claimed = commit(
    claimDispatchStop(
      f.state,
      system,
      {
        run_id: run.id,
        reason: "dispatch_timeout",
        lease_ms: 60000,
      },
      f.io,
    ),
  );
  if (!claimed?.dispatch_stop) throw new Error("Missing stop");
  commit(
    startDispatchStop(
      f.state,
      system,
      {
        run_id: run.id,
        attempt_id: claimed.dispatch_stop.attempt_id,
      },
      f.io,
    ),
  );
  f.state = {
    ...f.state,
    runs: f.state.runs.map((r) => ({ ...r, status: "unknown" })),
  };
  expect(occupiedRunSlots(f.state.assignments, f.state.runs, "local")).toBe(1);
  expect(queue()).toMatchObject({
    ok: false,
    error: { code: "invariant_violation" },
  });
  const next = commit(recover());
  expect(next?.status).toBe("queued");
  expect(occupiedRunSlots(f.state.assignments, f.state.runs, "local")).toBe(0);
  expect(
    f.state.events.find((e) => e.type === "run_dispatch_recovered")?.actor,
  ).toMatchObject({ kind: "system" });
  if (!next) throw new Error("Missing recovery");
  commit(dispatch(next));
  expect(occupiedRunSlots(f.state.assignments, f.state.runs, "local")).toBe(1);
});

test("inactivity cannot claim a second stop while a dispatch stop waits for preflight", () => {
  const claimed = commit(
    claimDispatchStop(
      f.state,
      system,
      {
        run_id: run.id,
        reason: "dispatch_timeout",
        lease_ms: 60000,
      },
      f.io,
    ),
  );
  if (!claimed?.dispatch_stop) throw new Error("Missing stop");
  commit(acknowledgeRun(f.state, actor(), { run_id: run.id }, f.io));
  now += 600000;
  expect(
    commit(
      claimInactiveRunStop(
        f.state,
        system,
        {
          run_id: run.id,
          after_ms: 100,
        },
        f.io,
      ),
    ),
  ).toBeUndefined();
  expect(f.state.runs[0]?.inactivity_stop).toBeUndefined();
  expect(f.state.runs[0]?.dispatch_stop).toEqual(claimed.dispatch_stop);
});

test("host cancellation retains a dispatch stop target and capacity until confirmed settlement", () => {
  now += 600000;
  const claimed = commit(
    claimDispatchStop(
      f.state,
      system,
      {
        run_id: run.id,
        reason: "dispatch_timeout",
        lease_ms: 60000,
      },
      f.io,
    ),
  );
  if (!claimed?.dispatch_stop) throw new Error("Missing stop");
  commit(
    startDispatchStop(
      f.state,
      system,
      {
        run_id: run.id,
        attempt_id: claimed.dispatch_stop.attempt_id,
      },
      f.io,
    ),
  );
  commit(
    abortDispatch(
      f.state,
      system,
      { run_id: run.id, reason: "host stopped" },
      f.io,
    ),
  );
  expect(
    f.state.assignments.find((a) => a.id === run.assignment_id)?.runtime_ref,
  ).toEqual(claimed.dispatch_stop.runtime_ref);
  expect(occupiedRunSlots(f.state.assignments, f.state.runs, "local")).toBe(1);
  expect(queue()).toMatchObject({
    ok: false,
    error: { code: "invariant_violation" },
  });
  expect(
    releaseAssignment(
      f.state,
      { kind: "human", project_id: f.state.project_id },
      {
        assignment_id: run.assignment_id,
      },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  expect(commit(recover())).toBeUndefined();
  expect(f.state.runs).toHaveLength(1);
  expect(f.state.runs[0]).toMatchObject({
    status: "cancelled",
    summary: "host stopped",
  });
  expect(f.state.runs[0]?.dispatch_stop).toBeUndefined();
  expect(occupiedRunSlots(f.state.assignments, f.state.runs, "local")).toBe(0);
});
const recover = (target = run, failed_attempts = 0) => {
  const current = f.state.runs.find((r) => r.id === target.id) ?? target;
  const used = f.state.events.some((e) => e.type === "run_dispatch_recovered");
  if (
    !used &&
    current.status === "dispatched" &&
    (failed_attempts >= 5 ||
      now - Date.parse(dispatchedAt(f.state, current) ?? f.io.clock.now()) >=
        600000)
  ) {
    const claimed = commit(
      claimDispatchStop(
        f.state,
        system,
        {
          run_id: current.id,
          reason: "dispatch_timeout",
          lease_ms: 60000,
        },
        f.io,
      ),
    );
    if (claimed?.dispatch_stop)
      commit(
        startDispatchStop(
          f.state,
          system,
          { run_id: current.id, attempt_id: claimed.dispatch_stop.attempt_id },
          f.io,
        ),
      );
  }
  const stop = f.state.runs.find((r) => r.id === target.id)?.dispatch_stop;
  return recoverDispatch(
    f.state,
    system,
    {
      run_id: target.id,
      timeout_ms: 600000,
      failed_attempts,
      max_failures: 5,
      ...(stop
        ? { stop_id: stop.attempt_id, stopped_runtime: stop.runtime_ref }
        : {}),
    },
    f.io,
  );
};

test("timeout cancels and queues atomically, preserves snapshot and spends the Assignment's only recovery", () => {
  now += 599999;
  expect(commit(recover())).toBeUndefined();
  now++;
  const replacement = commit(recover());
  expect(replacement).toMatchObject({
    status: "queued",
    model: run.model,
    kind: run.kind,
    role_version: run.role_version,
  });
  expect(f.state.runs.find((r) => r.id === run.id)).toMatchObject({
    status: "cancelled",
    outcome: "failed",
  });
  expect(
    f.state.runs.filter(
      (r) => !["cancelled", "completed", "failed"].includes(r.status),
    ),
  ).toHaveLength(1);
  expect(commit(recover())).toBeUndefined();
  if (!replacement) throw new Error("Missing recovery");
  commit(dispatch(replacement));
  now += 600000;
  expect(commit(recover(replacement))).toBeUndefined();
  expect(f.state.runs).toHaveLength(2);
  expect(f.state.human_actions).toHaveLength(1);
  expect(f.state.human_actions[0]?.instructions).toContain(
    `cardigan assignment stop ${f.coder.id}`,
  );
  expect(f.state.human_actions[0]?.instructions).toContain("10 分钟");
  commit(recover(replacement));
  expect(f.state.human_actions).toHaveLength(1);
});

test("consecutive failure threshold recovers before timeout; a real MCP start wins", () => {
  expect(commit(recover(run, 4))).toBeUndefined();
  const replacement = commit(recover(run, 5));
  if (!replacement) throw new Error("Missing recovery");
  commit(dispatch(replacement));
  commit(acknowledgeRun(f.state, actor(), { run_id: replacement.id }, f.io));
  now += 600000;
  expect(commit(recover(replacement, 5))).toBeUndefined();
  expect(f.state.human_actions).toEqual([]);
});

test("agents cannot recover Runs and paused/released Assignments never auto-resume", () => {
  expect(
    recoverDispatch(
      f.state,
      actor(),
      { run_id: run.id, timeout_ms: 1, failed_attempts: 5, max_failures: 5 },
      f.io,
    ).ok,
  ).toBe(false);
  for (const status of ["suspended", "released"] as const) {
    f.state = {
      ...f.state,
      assignments: f.state.assignments.map((a) =>
        a.id === run.assignment_id ? { ...a, status } : a,
      ),
    };
    expect(commit(recover(run, 5))).toBeUndefined();
  }
  expect(f.state.runs).toHaveLength(1);
});

test("automatic cancellation requires proof for the exact current terminal", () => {
  const params = {
    run_id: run.id,
    timeout_ms: 1,
    failed_attempts: 5,
    max_failures: 5,
  };
  expect(recoverDispatch(f.state, system, params, f.io).ok).toBe(false);
  expect(
    recoverDispatch(f.state, system, { ...params, stopped_runtime: null }, f.io)
      .ok,
  ).toBe(false);
  expect(f.state.runs[0]?.status).toBe("dispatched");
});

test("active PM Ops receives the escalation without a human action", () => {
  const replacement = commit(recover(run, 5));
  if (!replacement) throw new Error("Missing recovery");
  commit(dispatch(replacement));
  const { work_item_id: _workItem, ...standing } = f.coder;
  f.state = {
    ...f.state,
    assignments: [
      ...f.state.assignments,
      {
        ...standing,
        id: "A-999" as never,
        scope: "standing",
        role_id: "pm",
        standing_mode: "ops",
      },
    ],
  };
  commit(recover(replacement, 5));
  expect(f.state.events.at(-1)?.payload).toMatchObject({ audience: "pm_ops" });
  expect(f.state.human_actions).toEqual([]);
});

test("completed Run and released Assignment attention resolves without changing ACK cursors", () => {
  const note: Notification = {
    id: "notice",
    project_id: f.state.project_id,
    event_id: run.trigger_event_id,
    recipient: { kind: "assignment", assignment_id: f.coder.id },
    seq: 1,
    kind: "run_attention",
    status: "needs_attention",
    attempts: 1,
    run_id: run.id,
    created_at: f.io.clock.now(),
    updated_at: f.io.clock.now(),
  };
  expect(obsoleteDispatchAttention(f.state, note)).toBe(false);
  commit(recover(run, 5));
  expect(obsoleteDispatchAttention(f.state, note)).toBe(true);
  expect(f.state.cursors).toEqual([]);
  const missingRun = { ...note, run_id: undefined } as unknown as Notification;
  f.state = {
    ...f.state,
    assignments: f.state.assignments.map((a) => ({ ...a, status: "released" })),
  };
  expect(obsoleteDispatchAttention(f.state, missingRun)).toBe(true);
});

test("late start closes the Needs You action after escalation", () => {
  const replacement = commit(recover(run, 5));
  if (!replacement) throw new Error("Missing recovery");
  commit(dispatch(replacement));
  commit(recover(replacement, 5));
  expect(f.state.human_actions[0]?.status).toBe("open");
  commit(acknowledgeRun(f.state, actor(), { run_id: replacement.id }, f.io));
  commit(resolveDispatchAttention(f.state, system, f.io));
  expect(f.state.human_actions[0]?.status).toBe("cancelled");
  const count = f.state.events.length;
  commit(resolveDispatchAttention(f.state, system, f.io));
  expect(f.state.events).toHaveLength(count);
});

test("dispatch recovery retains the original conflict fix's review exemption", () => {
  const item = f.state.work_items.find((w) => w.id === f.coder.work_item_id);
  if (!item) throw new Error("Missing item");
  const event = {
    id: f.io.ids.nextEventId(),
    seq: 100,
    card_id: item.card_id,
    type: "merge_conflicted",
    actor: system,
    created_at: f.io.clock.now(),
    payload: { work_item_id: item.id },
  };
  run = { ...run, kind: "fix", trigger_event_id: event.id };
  f.state = { ...f.state, events: [...f.state.events, event], runs: [run] };
  const replacement = commit(recover(run, 5));
  if (!replacement) throw new Error("Missing recovery");
  const draft = new CommandDraft(f.state, system, "recover_dispatch", f.io);
  expect(conflictRepairEvent(draft, item, replacement, false)).toBe(event.id);
});

test("started stop fences MCP acknowledgement and finish, but an unstarted claim can withdraw", () => {
  const claimed = commit(
    claimDispatchStop(
      f.state,
      system,
      { run_id: run.id, reason: "dispatch_timeout", lease_ms: 60000 },
      f.io,
    ),
  );
  if (!claimed?.dispatch_stop) throw new Error("Missing stop");
  commit(
    startDispatchStop(
      f.state,
      system,
      { run_id: run.id, attempt_id: claimed.dispatch_stop.attempt_id },
      f.io,
    ),
  );
  expect(
    acknowledgeRun(f.state, actor(), { run_id: run.id }, f.io),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  expect(
    finishRun(
      f.state,
      actor(),
      { run_id: run.id, outcome: "completed", summary: "late" },
      f.io,
    ).ok,
  ).toBe(false);
  expect(f.state.runs[0]?.status).toBe("dispatched");
});

test("expired stop owner cannot settle after takeover; unknown Run resumes once", () => {
  const first = commit(
    claimDispatchStop(
      f.state,
      system,
      { run_id: run.id, reason: "dispatch_timeout", lease_ms: 100 },
      f.io,
    ),
  );
  if (!first?.dispatch_stop) throw new Error("Missing stop");
  commit(
    startDispatchStop(
      f.state,
      system,
      { run_id: run.id, attempt_id: first.dispatch_stop.attempt_id },
      f.io,
    ),
  );
  f.state = {
    ...f.state,
    runs: f.state.runs.map((r) => ({ ...r, status: "unknown" })),
  };
  now += 101;
  const second = commit(
    claimDispatchStop(
      f.state,
      system,
      { run_id: run.id, reason: "dispatch_timeout", lease_ms: 100 },
      f.io,
    ),
  );
  if (!second?.dispatch_stop) throw new Error("Missing takeover");
  const finish = (id: string) =>
    recoverDispatch(
      f.state,
      system,
      {
        run_id: run.id,
        timeout_ms: 100,
        failed_attempts: 0,
        max_failures: 5,
        stop_id: id,
        stopped_runtime: first.dispatch_stop?.runtime_ref ?? null,
      },
      f.io,
    );
  expect(commit(finish(first.dispatch_stop.attempt_id))).toBeUndefined();
  expect(commit(finish(second.dispatch_stop.attempt_id))?.status).toBe(
    "queued",
  );
  expect(commit(finish(second.dispatch_stop.attempt_id))).toBeUndefined();
  expect(f.state.runs).toHaveLength(2);
  expect(f.state.runs[0]?.dispatch_stop).toBeUndefined();
});
