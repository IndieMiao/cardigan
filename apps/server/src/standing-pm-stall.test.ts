import {
  type Assignment,
  type CardId,
  requestDecision,
  STANDING_PM_STALL_EVENTS,
} from "@cardigan/domain";
import { standingPmStallPolicy } from "@cardigan/host";
import { standingResolver } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { setup } from "../test-support/dispatch-stalls.js";
import { Dispatcher } from "./dispatch.js";

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
