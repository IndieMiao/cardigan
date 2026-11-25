import { beforeEach, expect, test } from "vitest";
import {
  abortDispatch,
  acknowledgeRun,
  type CardId,
  claimDispatchStop,
  claimInactiveRunStop,
  dispatchedAt,
  dispatchRecoveryUsed,
  finishRun,
  type Notification,
  obsoleteDispatchAttention,
  occupiedRunSlots,
  type Run,
  recordRunAckRefusal,
  recoverDispatch,
  releaseAssignment,
  resolveDispatchAttention,
  retireUnreadableQueuedRun,
  startDispatchStop,
  unreadableCommentTrigger,
  withdrawDispatchStop,
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
  const used = dispatchRecoveryUsed(f.state.events, current.assignment_id);
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

test("C-735: a refused start acknowledgement is reported once with its reason, never stopped or requeued", () => {
  commit(
    recordRunAckRefusal(
      f.state,
      actor(),
      { run_id: run.id, code: "illegal_transition", message: "等待当前任务" },
      f.io,
    ),
  );
  now += 600000;
  expect(
    commit(
      claimDispatchStop(
        f.state,
        system,
        { run_id: run.id, reason: "dispatch_timeout", lease_ms: 60000 },
        f.io,
      ),
    ),
  ).toBeUndefined();
  const before = f.state.events.length;
  commit(recover());
  const current = f.state.runs.find((r) => r.id === run.id);
  expect(current?.status).toBe("dispatched");
  expect(current?.dispatch_stop).toBeUndefined();
  const added = f.state.events.slice(before);
  expect(added.map((e) => e.type)).not.toContain("run_dispatch_recovered");
  const alert = added.find((e) => e.type === "run_dispatch_stalled");
  expect(alert?.payload).toMatchObject({
    run_id: run.id,
    reason: "ack_refused",
    ack_refusal: { code: "illegal_transition", message: "等待当前任务" },
  });
  const body = String((alert?.payload as { body?: string } | undefined)?.body);
  expect(body).toContain("等待当前任务");
  expect(body).not.toContain("assignment stop");
  const after = f.state.events.length;
  commit(recover());
  expect(f.state.events.length).toBe(after);
});

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
  now += 599999;
  expect(commit(recover(replacement))).toBeUndefined();
  expect(f.state.human_actions).toEqual([]);
  now++;
  expect(commit(recover(replacement))).toBeUndefined();
  expect(f.state.runs).toHaveLength(2);
  expect(f.state.human_actions).toHaveLength(1);
  expect(f.state.human_actions[0]?.instructions).toContain(
    `cardigan assignment stop ${f.coder.id}`,
  );
  expect(f.state.human_actions[0]?.instructions).toContain("20 分钟");
  expect(
    f.state.events.find((e) => e.type === "run_dispatch_stalled")?.payload,
  ).toMatchObject({ reason: "dispatch_timeout", waited_ms: 1200000 });
  commit(recover(replacement));
  expect(f.state.human_actions).toHaveLength(1);
});

test.each([false, true])(
  "startup failure includes original dispatch and replacement queue time (dispatched=%s)",
  (dispatched) => {
    now += 600000;
    const replacement = commit(recover());
    if (!replacement) throw new Error("Missing recovery");
    now += 120000;
    if (dispatched) commit(dispatch(replacement));
    now += 60000;
    commit(
      abortDispatch(
        f.state,
        system,
        { run_id: replacement.id, reason: "startup_failed" },
        f.io,
      ),
    );
    commit(recover(replacement));
    expect(
      f.state.events.find((e) => e.type === "run_dispatch_stalled")?.payload,
    ).toMatchObject({
      run_id: replacement.id,
      reason: "recovery_startup_failed",
      waited_ms: 780000,
      body: expect.stringContaining("派发后已等待 13 分钟"),
      audience: "needs_you",
    });
    expect(f.state.human_actions[0]?.instructions).toContain(
      "派发后已等待 13 分钟，自动恢复后的启动失败",
    );
  },
);

test.each(["cancelled", "failed"] as const)(
  "C-220 a %s recovery Run retires only its own diagnostic, retaining escalation until recovery",
  (status) => {
    const replacement = commit(recover(run, 5));
    if (!replacement) throw new Error("Missing recovery");
    commit(
      abortDispatch(
        f.state,
        system,
        { run_id: replacement.id, reason: "startup_failed" },
        f.io,
      ),
    );
    f.state = {
      ...f.state,
      runs: f.state.runs.map((r) =>
        r.id === replacement.id ? { ...r, status } : r,
      ),
    };
    commit(recover(replacement));
    const event = f.state.events.find((e) => e.type === "run_dispatch_stalled");
    if (!event) throw new Error("Missing startup failure alert");
    const own: Notification = {
      id: "diagnostic",
      project_id: f.state.project_id,
      event_id: event.id,
      recipient: { kind: "assignment", assignment_id: f.coder.id },
      seq: event.seq,
      kind: "run_attention",
      status: "needs_attention",
      attempts: 0,
      created_at: f.io.clock.now(),
      updated_at: f.io.clock.now(),
    };
    const recipients: Notification["recipient"][] = [
      { kind: "assignment", assignment_id: f.reviewer.id },
      { kind: "pm_ops" },
      { kind: "pm_office" },
      { kind: "needs_you" },
    ];
    const notices = recipients.map(
      (recipient): Notification => ({
        ...own,
        recipient,
        status: "pending",
      }),
    );
    const stale = () =>
      notices.map((n) => obsoleteDispatchAttention(f.state, n));
    expect(obsoleteDispatchAttention(f.state, own)).toBe(true);
    expect(stale()).toEqual([false, false, false, false]);

    const unresolved = f.state;
    const next = commit(queue());
    expect(stale()).toEqual([false, false, false, false]);
    commit(dispatch(next));
    expect(stale()).toEqual([false, false, false, false]);
    commit(acknowledgeRun(f.state, actor(), { run_id: next.id }, f.io));
    expect(stale()).toEqual([true, true, true, true]);
    expect(f.state.cursors).toEqual([]);

    f.state = {
      ...unresolved,
      assignments: unresolved.assignments.map((a) =>
        a.id === f.coder.id ? { ...a, status: "released" } : a,
      ),
    };
    expect(stale()).toEqual([true, true, true, true]);
    expect(f.state.cursors).toEqual([]);
  },
);

test("a later independent Run does not inherit a previous recovery's waiting time", () => {
  now += 600000;
  const replacement = commit(recover());
  if (!replacement) throw new Error("Missing recovery");
  commit(dispatch(replacement));
  commit(acknowledgeRun(f.state, actor(), { run_id: replacement.id }, f.io));
  commit(
    finishRun(
      f.state,
      actor(),
      { run_id: replacement.id, outcome: "completed", summary: "Recovered" },
      f.io,
    ),
  );
  now += 600000;
  const later = commit(dispatch(commit(queue())));
  now += 120000;
  commit(recover(later, 5));
  expect(
    f.state.events.find((e) => e.type === "run_dispatch_stalled")?.payload,
  ).toMatchObject({
    run_id: later.id,
    reason: "delivery_retry_exhausted",
    waited_ms: 120000,
    body: expect.stringContaining("派发后已等待 2 分钟"),
  });
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

test("C-106: a recovery replacement Run keeps the original Run's launch settings", () => {
  f.state = {
    ...f.state,
    runs: f.state.runs.map((r) =>
      r.id === run.id ? { ...r, harness: "codex", effort: "high" } : r,
    ),
  };
  now += 600000;
  const next = commit(recover());
  expect(next).toMatchObject({
    status: "queued",
    harness: "codex",
    effort: "high",
  });
});

function foreignTrigger(type = "comment_posted") {
  const source = {
    id: f.io.ids.nextEventId(),
    seq: 1,
    card_id: "C-999" as CardId,
    type,
    actor: system,
    payload: {},
    created_at: f.io.clock.now(),
  };
  run = {
    ...(f.state.runs.find((r) => r.id === run.id) ?? run),
    trigger_event_id: source.id,
    kind: "followup",
  };
  f.state = {
    ...f.state,
    events: [...f.state.events, source],
    runs: f.state.runs.map((r) => (r.id === run.id ? run : r)),
  };
  return source;
}

test("C-120: unreadable comment timeout cancels after exact exit proof without requeueing or spending recovery budget", () => {
  const source = foreignTrigger();
  const before = f.state;
  expect(
    recoverDispatch(
      f.state,
      system,
      {
        run_id: run.id,
        timeout_ms: 1,
        failed_attempts: 5,
        max_failures: 5,
      },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  now += 600000;
  expect(commit(recover())).toBeUndefined();
  expect(f.state.runs).toHaveLength(before.runs.length);
  expect(f.state.runs[0]).toMatchObject({
    status: "cancelled",
    outcome: "failed",
  });
  expect(f.state.runs[0]?.dispatch_stop).toBeUndefined();
  expect(f.state.cursors).toEqual(before.cursors);
  expect(f.state.work_items).toEqual(before.work_items);
  expect(
    f.state.events.filter((e) => e.type === "run_dispatch_recovered"),
  ).toEqual([]);
  expect(
    f.state.events.find((e) => e.type === "run_unreadable_trigger_cancelled")
      ?.payload,
  ).toMatchObject({
    source_event_id: source.id,
    reason: "recipient_cannot_read_card",
    run_id: run.id,
  });
  expect(commit(recover())).toBeUndefined();
});

test("C-120: host-only queued cancellation preserves the existing session and business state", () => {
  setup();
  run = commit(queue());
  foreignTrigger();
  const before = f.state;
  expect(
    retireUnreadableQueuedRun(f.state, actor(), { run_id: run.id }, f.io).ok,
  ).toBe(false);
  commit(retireUnreadableQueuedRun(f.state, system, { run_id: run.id }, f.io));
  expect(f.state.runs[0]).toMatchObject({
    status: "cancelled",
    outcome: "failed",
  });
  expect(f.state.assignments).toEqual(before.assignments);
  expect(f.state.work_items).toEqual(before.work_items);
  expect(f.state.cursors).toEqual(before.cursors);
  const count = f.state.events.length;
  commit(retireUnreadableQueuedRun(f.state, system, { run_id: run.id }, f.io));
  expect(f.state.events).toHaveLength(count);
});

test("C-120: queued cleanup cannot cancel a dispatched, started, external or readable Run", () => {
  foreignTrigger();
  const before = f.state;
  commit(retireUnreadableQueuedRun(f.state, system, { run_id: run.id }, f.io));
  expect(f.state.runs).toEqual(before.runs);
  for (const variant of [
    "started",
    "external",
    "readable",
    "standing",
  ] as const) {
    setup();
    run = commit(queue());
    foreignTrigger(
      variant === "readable" ? "dependency_completed" : "comment_posted",
    );
    if (variant === "started")
      f.state = {
        ...f.state,
        runs: [{ ...run, started_at: f.io.clock.now() }],
      };
    if (variant === "external" || variant === "standing")
      f.state = {
        ...f.state,
        assignments: f.state.assignments.map((a) => {
          if (a.id !== run.assignment_id) return a;
          if (variant === "external") return { ...a, external: true };
          const { work_item_id: _, ...rest } = a;
          return { ...rest, scope: "standing" as const };
        }),
      };
    const current = f.state;
    commit(
      retireUnreadableQueuedRun(f.state, system, { run_id: run.id }, f.io),
    );
    expect(f.state.runs).toEqual(current.runs);
    expect(f.state.events).toEqual(current.events);
  }
});

test("C-120: legitimate cross-card business triggers retain automatic recovery", () => {
  foreignTrigger("dependency_completed");
  expect(unreadableCommentTrigger(f.state, run)).toBeUndefined();
  now += 600000;
  expect(commit(recover())?.status).toBe("queued");
});

test.each([false, true])(
  "C-120: an already recovered Run retains its unreadable comment ancestry (dispatched=%s)",
  (dispatched) => {
    const replacement = commit(recover(run, 5));
    if (!replacement) throw new Error("Missing replacement");
    const source = foreignTrigger();
    f.state = {
      ...f.state,
      events: f.state.events.map((e) =>
        e.type === "run_dispatch_recovered"
          ? {
              ...e,
              payload: {
                assignment_id: run.assignment_id,
                run_id: run.id,
                replacement_run_id: replacement.id,
                original_trigger_event_id: source.id,
              },
            }
          : e,
      ),
    };
    expect(unreadableCommentTrigger(f.state, replacement)).toEqual(source);
    if (dispatched) {
      commit(dispatch(replacement));
      const claimed = commit(
        claimDispatchStop(
          f.state,
          system,
          {
            run_id: replacement.id,
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
            run_id: replacement.id,
            attempt_id: claimed.dispatch_stop.attempt_id,
          },
          f.io,
        ),
      );
      expect(commit(recover(replacement))).toBeUndefined();
    } else
      commit(
        retireUnreadableQueuedRun(
          f.state,
          system,
          { run_id: replacement.id },
          f.io,
        ),
      );
    expect(f.state.runs.find((r) => r.id === replacement.id)?.status).toBe(
      "cancelled",
    );
    expect(f.state.runs).toHaveLength(2);
  },
);

// C-247: the startup check uses the same stop fence and settlement; only the
// recovery budget differs.
const restart = (target: Run, opts: { exited?: boolean } = {}) => {
  const claimed = commit(
    claimDispatchStop(
      f.state,
      system,
      { run_id: target.id, reason: "server_restart", lease_ms: 60000 },
      f.io,
    ),
  );
  const stop = claimed?.dispatch_stop;
  if (!stop) throw new Error("No restart stop claimed");
  commit(
    startDispatchStop(
      f.state,
      system,
      { run_id: target.id, attempt_id: stop.attempt_id },
      f.io,
    ),
  );
  return recoverDispatch(
    f.state,
    system,
    {
      run_id: target.id,
      timeout_ms: 600000,
      failed_attempts: 0,
      max_failures: 5,
      stop_id: stop.attempt_id,
      ...(opts.exited === false
        ? { stop_failed: true }
        : { stopped_runtime: stop.runtime_ref }),
    },
    f.io,
  );
};

test("C-247: a server-restart stop requeues before the timeout without spending the Assignment's recovery", () => {
  now += 1000;
  const replacement = commit(restart(run));
  expect(replacement).toMatchObject({ status: "queued", kind: run.kind });
  expect(f.state.runs.find((r) => r.id === run.id)).toMatchObject({
    status: "cancelled",
    outcome: "failed",
  });
  expect(
    f.state.events.find((e) => e.type === "run_dispatch_recovered")?.payload,
  ).toMatchObject({ run_id: run.id, reason: "server_restart" });
  expect(dispatchRecoveryUsed(f.state.events, run.assignment_id)).toBe(false);
  if (!replacement) throw new Error("Missing recovery");
  commit(dispatch(replacement));
  // The ordinary timeout still has its one recovery…
  now += 600000;
  const second = commit(recover(replacement));
  expect(second?.status).toBe("queued");
  expect(dispatchRecoveryUsed(f.state.events, run.assignment_id)).toBe(true);
  if (!second) throw new Error("Missing second recovery");
  commit(dispatch(second));
  // …and only one: the next timeout escalates.
  now += 600000;
  expect(commit(recover(second))).toBeUndefined();
  expect(
    f.state.events.filter((e) => e.type === "run_dispatch_stalled"),
  ).toHaveLength(1);
});

test("C-247: a server-restart stop still requeues after the timeout recovery was spent", () => {
  now += 600000;
  const replacement = commit(recover());
  if (!replacement) throw new Error("Missing recovery");
  commit(dispatch(replacement));
  now += 1000;
  const next = commit(restart(replacement));
  expect(next?.status).toBe("queued");
  expect(f.state.events.some((e) => e.type === "run_dispatch_stalled")).toBe(
    false,
  );
});

test("C-247: a server-restart stop cannot bypass the Run state machine or exit proof", () => {
  // Without confirmed exit the Run and its credentials stay; nothing requeues.
  now += 1000;
  expect(commit(restart(run, { exited: false }))).toBeUndefined();
  expect(f.state.runs).toHaveLength(1);
  expect(f.state.runs[0]?.status).toBe("dispatched");
  expect(
    f.state.events.find((e) => e.type === "run_dispatch_stalled")?.payload,
  ).toMatchObject({ reason: "server_restart" });
  // A started Run cannot be claimed for a restart stop.
  setup();
  run = commit(dispatch(commit(queue())));
  commit(acknowledgeRun(f.state, actor(), { run_id: run.id }, f.io));
  expect(() => restart(run)).toThrow("No restart stop claimed");
  expect(f.state.runs[0]?.dispatch_stop).toBeUndefined();
  // Without a stop fence the restart reason cannot settle anything.
  expect(
    commit(
      recoverDispatch(
        f.state,
        system,
        {
          run_id: run.id,
          timeout_ms: 600000,
          failed_attempts: 0,
          max_failures: 5,
          stop_id: "missing",
          stopped_runtime: null,
        },
        f.io,
      ),
    ),
  ).toBeUndefined();
  expect(f.state.runs).toHaveLength(1);
});

// The RuntimeMonitor marks a Run unknown (and its session unknown) when the
// terminal is reported missing; the startup check must still take it.
const markUnknown = (started = false) => {
  f.state = {
    ...f.state,
    runs: f.state.runs.map((r) =>
      r.id === run.id
        ? {
            ...r,
            status: "unknown",
            ...(started ? { started_at: f.io.clock.now() } : {}),
          }
        : r,
    ),
    assignments: f.state.assignments.map((a) =>
      a.id === run.assignment_id ? { ...a, runtime_state: "unknown" } : a,
    ),
  };
};

test("C-247: only a server-restart stop may freshly claim an unstarted unknown Run, and it settles through the state machine", () => {
  markUnknown();
  const claim = (reason: "dispatch_timeout" | "server_restart") =>
    commit(
      claimDispatchStop(
        f.state,
        system,
        { run_id: run.id, reason, lease_ms: 60000 },
        f.io,
      ),
    );
  // The timeout policy keeps its existing scope.
  expect(claim("dispatch_timeout")).toBeUndefined();
  expect(f.state.runs[0]?.dispatch_stop).toBeUndefined();
  now += 1000;
  const replacement = commit(restart({ ...run, status: "unknown" }));
  expect(replacement?.status).toBe("queued");
  expect(f.state.runs.find((r) => r.id === run.id)?.status).toBe("cancelled");
  const a = f.state.assignments.find((x) => x.id === run.assignment_id);
  expect(a?.runtime_state).toBe("idle");
  expect(a?.runtime_ref).toBeNull();
  expect(dispatchRecoveryUsed(f.state.events, run.assignment_id)).toBe(false);
});

test("C-247: a started unknown Run is never claimed for a server-restart stop", () => {
  markUnknown(true);
  expect(
    commit(
      claimDispatchStop(
        f.state,
        system,
        { run_id: run.id, reason: "server_restart", lease_ms: 60000 },
        f.io,
      ),
    ),
  ).toBeUndefined();
  expect(f.state.runs[0]?.dispatch_stop).toBeUndefined();
});

test("C-247: withdrawing a restart stop clears only its own unstarted fence", () => {
  const claimed = commit(
    claimDispatchStop(
      f.state,
      system,
      { run_id: run.id, reason: "server_restart", lease_ms: 60000 },
      f.io,
    ),
  );
  const stop = claimed?.dispatch_stop;
  if (!stop) throw new Error("Missing stop");
  const withdraw = (attempt_id: string) =>
    commit(
      withdrawDispatchStop(
        f.state,
        system,
        { run_id: run.id, attempt_id, reason: "runtime_not_exited" },
        f.io,
      ),
    );
  expect(withdraw("other")).toBe(false);
  expect(f.state.runs[0]?.dispatch_stop).toBeDefined();
  expect(withdraw(stop.attempt_id)).toBe(true);
  expect(f.state.runs[0]).toMatchObject({ status: "dispatched" });
  expect(f.state.runs[0]?.dispatch_stop).toBeUndefined();
  expect(
    f.state.events.find((e) => e.type === "run_dispatch_stop_withdrawn")
      ?.payload,
  ).toMatchObject({ run_id: run.id, reason: "runtime_not_exited" });
  // A started fence is settled by its exit proof, never withdrawn.
  const again = commit(
    claimDispatchStop(
      f.state,
      system,
      { run_id: run.id, reason: "server_restart", lease_ms: 60000 },
      f.io,
    ),
  );
  if (!again?.dispatch_stop) throw new Error("Missing stop");
  commit(
    startDispatchStop(
      f.state,
      system,
      { run_id: run.id, attempt_id: again.dispatch_stop.attempt_id },
      f.io,
    ),
  );
  expect(withdraw(again.dispatch_stop.attempt_id)).toBe(false);
  expect(f.state.runs[0]?.dispatch_stop?.stopping).toBe(true);
  // Agents cannot withdraw a stop.
  expect(
    withdrawDispatchStop(
      f.state,
      actor(),
      {
        run_id: run.id,
        attempt_id: again.dispatch_stop.attempt_id,
        reason: "x",
      },
      f.io,
    ).ok,
  ).toBe(false);
});
