import {
  type Assignment,
  type CardId,
  type RuntimeRef,
  requestDecision,
  STANDING_PM_STALL_EVENTS,
} from "@cardigan/domain";
import {
  HostOpsService,
  StandingPmRecovery,
  standingPmStallPolicy,
} from "@cardigan/host";
import { moveNotification, standingResolver } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { setup } from "../test-support/dispatch-stalls.js";
import { Dispatcher } from "./dispatch.js";
import { acknowledgeInbox, routeStreamEvents } from "./dispatch-inbox.js";

const MIN = 60_000;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture");
  return value;
}

/**
 * C-596 replay of sensen A-31: PM Ops' turn R-388 was ended by the system,
 * the bound terminal then reports alive/unknown, and the exact turn-owner
 * check cannot confirm a kept terminal. Before C-596 the bell waited forever.
 */
function pmOps() {
  const f = setup();
  const created = f.pm();
  f.store.uow.run((tx) => {
    const role = tx.roles.get(f.project, { role_id: "pm", role_version: 1 });
    if (!role) throw new Error("Missing PM role");
    tx.roles.put(f.project, {
      ...role,
      allowed_tools: [...new Set([...role.allowed_tools, "request_decision"])],
    });
    tx.assignments.put(f.project, { ...created, standing_mode: "ops" });
  });
  const pm = required(f.state().assignments.find((a) => a.id === created.id));
  const turn = f.session(pm, false);
  f.apply(
    (s, a, p) =>
      requestDecision(
        s,
        a,
        {
          category: "general",
          kind: "choose",
          question: "Choose the next step",
          context: "fixture",
          options: [{ key: "go", description: "Go", impact: "Resume" }],
          recommended: "go",
          affected_cards: [],
          affected_work_items: [],
          blocking: true,
          decider: "human",
          plain_summary: { changed: "等待确认", impact: "暂停", risk: "无" },
        },
        p,
      ),
    f.actorFor(pm),
  );
  const ended = required(f.state().runs.find((r) => r.id === turn.id));
  expect(ended).toMatchObject({ status: "completed", outcome: "blocked" });
  const ref = f.refFor(pm);
  vi.mocked(f.runtime.status).mockImplementation(async (r) => ({
    ok: true,
    value:
      r.terminal_ref === ref.terminal_ref
        ? released.has(r.terminal_ref)
          ? { process: "exited", agent: "unknown", observed_seq: 2 }
          : { process: "alive", agent: "unknown", observed_seq: 1 }
        : { process: "alive", agent: "idle", observed_seq: 1 },
  }));
  // herdr answers "unknown" for a kept terminal on the system-turn path.
  f.runtime.observe_retirement = vi.fn(async () => ({
    ok: true as const,
    value: "unknown" as const,
  }));
  const released = new Set<string>();
  let stops = true;
  vi.mocked(f.runtime.release).mockImplementation(async (r) => {
    if (stops) released.add(r.terminal_ref);
    return { ok: true, value: undefined };
  });
  f.skipEvents();
  const notify = (card: CardId) =>
    f.event("delivery_submitted", { fixture: true }, pm as Assignment, card);
  const delivery = notify(f.target.card.id);
  const dispatcher = new Dispatcher({
    ...f.options,
    standing: standingResolver(f.store),
  });
  const events = (type: string) =>
    f.state().events.filter((e) => e.type === type);
  const note = () =>
    required(
      f.store
        .listNotifications({ project_id: f.project, assignment_id: pm.id })
        .find((n) => n.event_id === delivery.id),
    );
  const patrol = async (type: string, count = 1) => {
    f.advance(30_000);
    await vi.waitFor(async () => {
      await f.service.tick();
      expect(events(type).length).toBeGreaterThanOrEqual(count);
    });
  };
  return {
    f,
    pm,
    ref,
    turn,
    dispatcher,
    events,
    note,
    patrol,
    noStop: () => {
      stops = false;
    },
  };
}

test("default policy is 15 minutes, 5-minute grace, two restarts per hour; invalid values fail", () => {
  expect(standingPmStallPolicy({})).toEqual({
    threshold_ms: 15 * MIN,
    grace_ms: 5 * MIN,
    window_ms: 60 * MIN,
    max_restarts: 2,
  });
  expect(
    standingPmStallPolicy({ CARDIGAN_STANDING_PM_STALL_MS: "60000" })
      .threshold_ms,
  ).toBe(MIN);
  expect(() =>
    standingPmStallPolicy({ CARDIGAN_STANDING_PM_STALL_MAX_RESTARTS: "0" }),
  ).toThrow("CARDIGAN_STANDING_PM_STALL_MAX_RESTARTS");
});

test("C-596 replay: kept PM Ops terminal at alive/unknown is redelivered, restarted once and its original notice delivered", async () => {
  const { f, pm, ref, turn, dispatcher, events, note, patrol } = pmOps();
  try {
    await dispatcher.tick();
    expect(events("bell_wake_deferred")).toMatchObject([
      {
        payload: {
          assignment_id: pm.id,
          run_id: turn.id,
          reason: "system_finished_turn",
          activity_source: "alive/unknown",
        },
      },
    ]);
    f.advance(10 * MIN);
    await dispatcher.tick();
    expect(events("bell_turn_recovery_due")).toHaveLength(1);
    // Root cause: the turn-owner proof is "unknown" for this terminal, so the
    // system-turn restart is refused and nothing else ever restarts the PM.
    await patrol("bell_turn_recovery_failed");
    expect(events("bell_turn_recovery_failed")[0]?.payload).toMatchObject({
      reason: "unsafe_evidence",
      terminal_owner: "unconfirmed",
    });
    expect(events("host_ops_action_taken")).toHaveLength(0);
    expect(events(STANDING_PM_STALL_EVENTS.redeliver)).toHaveLength(0);

    f.advance(5 * MIN - 60_000);
    await dispatcher.tick();
    await patrol(STANDING_PM_STALL_EVENTS.redeliver);
    expect(events(STANDING_PM_STALL_EVENTS.redeliver)[0]).toMatchObject({
      card_id: f.target.card.id,
      payload: {
        assignment_id: pm.id,
        notification_ids: expect.arrayContaining([note().id]),
        observation: "alive/unknown",
      },
    });
    expect(events(STANDING_PM_STALL_EVENTS.restart)).toHaveLength(0);

    f.advance(5 * MIN);
    await dispatcher.tick();
    await patrol(STANDING_PM_STALL_EVENTS.restart);
    const [taken] = events("host_ops_action_taken");
    expect(taken?.payload).toMatchObject({
      tool: "host_ops_restart_standing_pm",
      assignment_id: pm.id,
      runtime_ref: ref,
    });
    await vi.waitFor(async () => {
      await f.service.tick();
      expect(events("host_ops_action_finished")).toHaveLength(1);
    });
    expect(f.runtime.release).toHaveBeenCalledWith(ref, { force: true });
    const [finished] = events("host_ops_action_finished");
    const successor = (finished?.payload as { run_id?: string } | undefined)
      ?.run_id;
    expect(successor).toBeTruthy();
    expect(events("standing_session_restarted")).toMatchObject([
      { payload: { assignment_id: pm.id } },
    ]);
    expect(f.state().decisions.filter((q) => q.status === "open")).toHaveLength(
      1,
    );
    // The fresh session receives the original notice; one executor only, and
    // the old terminal was never typed into.
    await dispatcher.tick();
    const runs = f.state().runs.filter((r) => r.assignment_id === pm.id);
    expect(
      runs.filter(
        (r) => !["completed", "failed", "cancelled"].includes(r.status),
      ),
    ).toMatchObject([{ id: successor, status: "dispatched" }]);
    // Still unread on the PM's cursor: the new session's get_updates returns it.
    expect(["pending", "belled"]).toContain(note().status);
    expect(
      f
        .state()
        .cursors.filter(
          (c) =>
            c.assignment_id === pm.id &&
            c.card_id === f.target.card.id &&
            c.acked_seq >= note().seq,
        ),
    ).toEqual([]);
    expect(f.runtime.wake).not.toHaveBeenCalled();
    expect(events(STANDING_PM_STALL_EVENTS.escalate)).toHaveLength(0);
    // No second recovery alert for the now-replaced turn.
    expect(events("bell_turn_recovery_failed")).toHaveLength(1);
  } finally {
    await dispatcher.close();
  }
});

test("C-596: an unconfirmed restart is escalated once to host operations, not to the human", async () => {
  const { f, pm, dispatcher, events, patrol, noStop } = pmOps();
  noStop();
  try {
    await dispatcher.tick();
    f.advance(15 * MIN);
    await patrol(STANDING_PM_STALL_EVENTS.redeliver);
    f.advance(5 * MIN);
    await patrol(STANDING_PM_STALL_EVENTS.restart);
    await f.service.tick();
    expect(events("host_ops_action_finished")).toHaveLength(0);
    f.advance(5 * MIN);
    await patrol(STANDING_PM_STALL_EVENTS.escalate);
    const [escalated] = events(STANDING_PM_STALL_EVENTS.escalate);
    expect(escalated?.payload).toMatchObject({
      assignment_id: pm.id,
      reason: "restart_unconfirmed",
    });
    expect(
      f.store
        .listNotifications({ project_id: f.project })
        .filter((n) => n.event_id === escalated?.id),
    ).toMatchObject([
      { recipient: { kind: "assignment", assignment_id: f.ops.id } },
    ]);
    f.advance(5 * MIN);
    await f.service.tick();
    expect(events(STANDING_PM_STALL_EVENTS.escalate)).toHaveLength(1);
    expect(
      f.state().human_actions.filter((h) => h.status === "open"),
    ).toHaveLength(0);
    const runs = f.state().runs.filter((r) => r.assignment_id === pm.id);
    expect(runs.filter((r) => r.started_at)).toHaveLength(1);
  } finally {
    await dispatcher.close();
  }
});

test("V-2944: an older turn recovery that cannot confirm exit is escalated once; nothing stops or starts beside it", async () => {
  const { f, pm, dispatcher, events, note, patrol } = pmOps();
  f.runtime.observe_retirement = vi.fn(async () => ({
    ok: true as const,
    value: "alive" as const,
  }));
  const signal = vi.fn();
  f.runtime.retire_idle = vi.fn(async (_ref, opts) => {
    if (!(await opts.workspace_preflight()) || !opts.before_signal())
      throw new Error("fixture guard refused");
    signal();
    return {
      ok: true as const,
      value: {
        outcome: "timeout" as const,
        evidence: { stage: "TERM" as const, reason: "still_live" as const },
      },
    };
  });
  try {
    await dispatcher.tick();
    f.advance(10 * MIN);
    await dispatcher.tick();
    await patrol("host_ops_action_taken");
    expect(events("host_ops_action_taken")[0]?.payload).toMatchObject({
      assignment_id: pm.id,
      system_finished_run_id: expect.any(String),
    });
    await vi.waitFor(async () => {
      await f.service.tick();
      expect(signal).toHaveBeenCalledTimes(1);
    });
    for (let i = 0; i < 3; i++) await patrol("host_ops_action_taken");
    expect(events(STANDING_PM_STALL_EVENTS.escalate)).toHaveLength(0);
    f.advance(5 * MIN);
    await patrol(STANDING_PM_STALL_EVENTS.escalate);
    const [escalated] = events(STANDING_PM_STALL_EVENTS.escalate);
    expect(escalated?.payload).toMatchObject({
      assignment_id: pm.id,
      reason: "restart_unconfirmed",
      handoff: "host_ops",
      host_ops_assignment_id: f.ops.id,
    });
    expect(
      f.store
        .listNotifications({ project_id: f.project })
        .filter((n) => n.event_id === escalated?.id)
        .map((n) => n.recipient),
    ).toEqual([{ kind: "assignment", assignment_id: f.ops.id }]);
    for (let i = 0; i < 8; i++) {
      f.advance(5 * MIN);
      await f.service.tick();
    }
    expect(events(STANDING_PM_STALL_EVENTS.escalate)).toHaveLength(1);
    expect(events(STANDING_PM_STALL_EVENTS.restart)).toHaveLength(0);
    expect(
      events("host_ops_action_taken").filter(
        (e) =>
          (e.payload as { assignment_id?: string }).assignment_id === pm.id,
      ),
    ).toHaveLength(1);
    expect(signal).toHaveBeenCalledTimes(1);
    expect(f.runtime.release).not.toHaveBeenCalled();
    expect(note().status).toBe("pending");
  } finally {
    await dispatcher.close();
  }
});

/** A PM idle after a normal Run, driven by the C-596 patrol alone. */
function idlePm(owns: (ref: RuntimeRef) => boolean = () => true) {
  const f = setup();
  const pm = f.pm();
  f.session(pm);
  f.skipEvents();
  const delivery = f.event(
    "delivery_submitted",
    { fixture: true },
    pm,
    f.target.card.id,
  );
  const patrol = () =>
    new StandingPmRecovery(
      f.store,
      f.clock,
      f.runtime,
      new AbortController().signal,
      standingPmStallPolicy(),
      owns,
    );
  let recovery = patrol();
  const tick = (snapshot = f.options.snapshot) =>
    recovery.tick(f.project, snapshot);
  /** A host restart: in-memory patrol state is gone. */
  const reboot = () => {
    recovery = patrol();
  };
  const events = (type: string) =>
    f.state().events.filter((e) => e.type === type);
  const note = () =>
    required(
      f.store
        .listNotifications({ project_id: f.project, assignment_id: pm.id })
        .find((n) => n.event_id === delivery.id),
    );
  const recipients = (id: string | undefined) =>
    f.store
      .listNotifications({ project_id: f.project })
      .filter((n) => n.event_id === id)
      .map((n) => n.recipient);
  return { f, pm, tick, events, note, recipients, reboot };
}

test("V-2944: a terminal on another runtime is escalated to host ops; no restart, no human action", async () => {
  const { f, tick, events, recipients } = idlePm(() => false);
  f.advance(15 * MIN);
  await tick();
  f.advance(5 * MIN);
  await tick();
  const [escalated] = events(STANDING_PM_STALL_EVENTS.escalate);
  expect(escalated?.payload).toMatchObject({ reason: "not_local" });
  expect(recipients(escalated?.id)).toEqual([
    { kind: "assignment", assignment_id: f.ops.id },
  ]);
  expect(events("host_ops_action_taken")).toHaveLength(0);
  expect(f.state().human_actions).toEqual([]);
});

test("V-2944: a handed-off notice gets a deliverable reminder; a healthy bell closes the episode", async () => {
  const { f, pm, tick, events, note } = idlePm();
  const original = note();
  f.store.uow.run(() =>
    moveNotification(f.store.database, {
      project_id: f.project,
      id: original.id,
      event: "needs_attention",
      at: f.clock.now(),
    }),
  );
  f.event("standing_inbox_stalled", {
    assignment_id: pm.id,
    reason: "pending_without_run",
    notification_ids: [original.id],
  } as unknown as Record<string, string>);
  f.skipEvents();
  f.advance(15 * MIN);
  await tick();
  const [redelivered] = events(STANDING_PM_STALL_EVENTS.redeliver);
  expect(redelivered?.payload).toMatchObject({
    notification_ids: [original.id],
  });
  const reminder = f.store
    .listNotifications({ project_id: f.project, assignment_id: pm.id })
    .find((n) => n.event_id === redelivered?.id);
  expect(reminder).toMatchObject({
    status: "pending",
    card_id: f.target.card.id,
  });
  // The original row and the PM's cursor are untouched.
  expect(note().status).toBe("needs_attention");
  const dispatcher = new Dispatcher(f.options);
  try {
    await dispatcher.tick();
    expect(f.runtime.wake).toHaveBeenCalled();
    f.advance(5 * MIN);
    await tick();
    expect(events(STANDING_PM_STALL_EVENTS.restart)).toHaveLength(0);
  } finally {
    await dispatcher.close();
  }
});

test("V-2944: a restart that cannot get a launch snapshot escalates after one more grace", async () => {
  const { f, tick, events } = idlePm();
  const broken = vi.fn(async () => {
    throw new Error("snapshot unavailable");
  });
  f.advance(15 * MIN);
  await tick();
  f.advance(5 * MIN);
  await tick(broken);
  expect(events(STANDING_PM_STALL_EVENTS.escalate)).toHaveLength(0);
  f.advance(5 * MIN);
  await tick(broken);
  expect(broken).toHaveBeenCalledTimes(1);
  const [escalated] = events(STANDING_PM_STALL_EVENTS.escalate);
  expect(escalated?.payload).toMatchObject({
    reason: "restart_unavailable",
    observation: expect.stringContaining("launch_snapshot_unavailable"),
  });
  for (let i = 0; i < 5; i++) {
    f.advance(10 * MIN);
    await tick(broken);
  }
  expect(events(STANDING_PM_STALL_EVENTS.escalate)).toHaveLength(1);
  expect(events(STANDING_PM_STALL_EVENTS.restart)).toHaveLength(0);
});

test("V-2944: without an active host_ops the escalation waits, then reaches one that comes on duty", async () => {
  const { f, tick, events, recipients } = idlePm(() => false);
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, { ...f.ops, status: "suspended" }),
  );
  f.advance(15 * MIN);
  await tick();
  f.advance(5 * MIN);
  await tick();
  const [escalated] = events(STANDING_PM_STALL_EVENTS.escalate);
  expect(escalated?.payload).toMatchObject({
    handoff: "waiting_host_ops",
    notice: expect.stringContaining("暂无在岗主机运维"),
  });
  expect(escalated?.payload).not.toHaveProperty("host_ops_assignment_id");
  // No unresolvable PM Office address is used as a stand-in.
  expect(recipients(escalated?.id)).toEqual([]);
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, { ...f.ops, status: "active" }),
  );
  f.advance(MIN);
  await tick();
  await tick();
  const handoffs = events("standing_pm_stall_handoff_delivered");
  expect(handoffs).toMatchObject([
    {
      payload: {
        escalation_id: escalated?.id,
        host_ops_assignment_id: f.ops.id,
      },
    },
  ]);
  // The notice is bound to the new handoff, not the earlier waiting event.
  expect(recipients(handoffs[0]?.id)).toEqual([
    { kind: "assignment", assignment_id: f.ops.id },
  ]);
  expect(recipients(escalated?.id)).toEqual([]);
  expect(f.state().human_actions).toEqual([]);
});

test("V-2959: a runtime change between intent and execution goes to host ops, never to the human", async () => {
  let owns = true;
  const { f, tick, events, recipients } = idlePm(() => owns);
  f.advance(15 * MIN);
  await tick();
  f.advance(5 * MIN);
  await tick();
  const [restart] = events(STANDING_PM_STALL_EVENTS.restart);
  expect(restart).toBeDefined();
  // The host now runs on another runtime and executes the persisted intent.
  owns = false;
  const svc = new HostOpsService({ ...f.options, ownsRuntimeRef: () => owns });
  try {
    await svc.tick();
    expect(f.runtime.release).not.toHaveBeenCalled();
    expect(f.state().human_actions).toEqual([]);
    expect(
      events("host_ops_action_deferred").map(
        (e) => (e.payload as { reason?: string }).reason,
      ),
    ).toContain("当前主机无法确认旧会话退出");
    f.advance(5 * MIN);
    await tick();
    await svc.tick();
    const [escalated] = events(STANDING_PM_STALL_EVENTS.escalate);
    expect(escalated?.payload).toMatchObject({
      reason: "restart_unconfirmed",
      handoff: "host_ops",
    });
    expect(recipients(escalated?.id)).toEqual([
      { kind: "assignment", assignment_id: f.ops.id },
    ]);
    expect(f.state().human_actions).toEqual([]);
    expect(
      f.state().runs.filter((r) => r.trigger_event_id === restart?.id),
    ).toEqual([]);
  } finally {
    await svc.close();
  }
});

test("V-2959: a late first patrol after a reboot attempts the restart instead of escalating", async () => {
  const { f, tick, events, reboot } = idlePm();
  const ready = vi.fn(f.options.snapshot);
  f.advance(15 * MIN);
  await tick(ready);
  expect(events(STANDING_PM_STALL_EVENTS.redeliver)).toHaveLength(1);
  reboot();
  f.advance(11 * MIN);
  await tick(ready);
  expect(ready).toHaveBeenCalledTimes(1);
  expect(events(STANDING_PM_STALL_EVENTS.restart)).toHaveLength(1);
  expect(events(STANDING_PM_STALL_EVENTS.escalate)).toHaveLength(0);
});

test("V-2959: a short valid grace with regular 30-second patrols still attempts the restart", async () => {
  vi.stubEnv("CARDIGAN_STANDING_PM_STALL_GRACE_MS", "10000");
  try {
    const { f, tick, events } = idlePm();
    const ready = vi.fn(f.options.snapshot);
    f.advance(15 * MIN);
    await tick(ready);
    f.advance(30_000);
    await tick(ready);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(events(STANDING_PM_STALL_EVENTS.restart)).toHaveLength(1);
    expect(events(STANDING_PM_STALL_EVENTS.escalate)).toHaveLength(0);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("V-2959: host ops that read the waiting notice still get a bell for the later handoff", async () => {
  const { f, tick, events } = idlePm(() => false);
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, { ...f.ops, status: "suspended" }),
  );
  f.advance(15 * MIN);
  await tick();
  f.advance(5 * MIN);
  await tick();
  const [wait] = events(STANDING_PM_STALL_EVENTS.escalate);
  expect(wait?.payload).toMatchObject({ handoff: "waiting_host_ops" });
  const card = required(wait?.card_id);
  f.store.uow.run((tx) =>
    tx.assignments.put(f.project, { ...f.ops, status: "active" }),
  );
  // The returning operator reads the card first and acknowledges it.
  const read = f.store.getUpdates({ project_id: f.project, card_id: card });
  expect(
    f.store.ackEvents({
      project_id: f.project,
      card_id: card,
      assignment_id: f.ops.id,
      up_to_seq: read.latest_seq,
    }).ok,
  ).toBe(true);
  f.advance(MIN);
  await tick();
  const [sent] = events("standing_pm_stall_handoff_delivered");
  expect(sent?.seq).toBeGreaterThan(read.latest_seq);
  routeStreamEvents(f.store, f.project, card, { clock: f.clock });
  acknowledgeInbox(f.store, f.project, undefined, f.clock);
  const forOps = f.store
    .listNotifications({ project_id: f.project, assignment_id: f.ops.id })
    .filter((n) => n.event_id === sent?.id);
  expect(forOps.map((n) => n.status)).toEqual(["pending"]);
  await tick();
  expect(events("standing_pm_stall_handoff_delivered")).toHaveLength(1);
});
