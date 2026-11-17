import {
  acknowledgeRun,
  dispatchRun,
  occupiedRunSlots,
  postComment,
  queueRun,
} from "@cardigan/domain";
import {
  beginBellAttempt,
  finishBellAttempt,
  listBellAttempts,
  Store,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";
import {
  resolveUnreadableNotifications,
  routeProjectEvents,
} from "./dispatch-inbox.js";

let f: ReturnType<typeof recoveryFixture>;
beforeEach(() => {
  f = recoveryFixture();
});
afterEach(() => f.close());

test("multiple unreadable mentions produce one Ops notification and a durable hint on the original card", () => {
  const others = [f.create(), f.create()];
  f.skipEvents();
  const entry = f.apply((s, a, p) =>
    postComment(
      s,
      a,
      {
        card_id: f.target.card.id,
        body: others.map((o) => `@${o.assignment.id}`).join(" "),
      },
      p,
    ),
  );
  const cursor = f.store.routerCursor(f.project, f.target.card.id);
  f.store.database.exec(`CREATE TEMP TRIGGER fail_hint BEFORE INSERT ON timeline
    WHEN json_extract(NEW.doc, '$.type') = 'system'
    BEGIN SELECT RAISE(ABORT, 'hint unavailable'); END;`);
  expect(() => routeProjectEvents(f.store, f.project)).toThrow(
    /hint unavailable/,
  );
  expect(f.store.routerCursor(f.project, f.target.card.id)).toBe(cursor);
  expect(f.store.listNotifications({ project_id: f.project })).toEqual([]);
  f.store.database.exec("DROP TRIGGER fail_hint");
  routeProjectEvents(f.store, f.project);
  expect(f.store.listNotifications({ project_id: f.project })).toMatchObject([
    { recipient: { kind: "pm_ops" }, kind: "escalation", seq: entry.event_seq },
  ]);
  const notice = f
    .state()
    .timeline.find((t) => t.type === "system" && t.body.includes("提及未送达"));
  expect(notice?.card_id).toBe(f.target.card.id);
  for (const other of others)
    expect(notice?.body).toContain(`@${other.assignment.id} 无权读取本卡`);
  const reopened = Store.open({ dataDir: f.dataDir });
  try {
    routeProjectEvents(reopened, f.project);
    expect(routeProjectEvents(reopened, f.project)).toBe(0);
  } finally {
    reopened.close();
  }
  expect(
    f.state().events.filter((e) => e.type === "comment_mention_redirected"),
  ).toHaveLength(1);
  expect(f.store.listNotifications({ project_id: f.project })).toHaveLength(1);
});

function legacy() {
  const other = f.create();
  f.skipEvents();
  const entry = f.apply((s, a, p) =>
    postComment(
      s,
      a,
      { card_id: other.card.id, body: "Legacy cross-card mention" },
      p,
    ),
  );
  const event = f
    .state()
    .events.find(
      (e) => e.card_id === other.card.id && e.seq === entry.event_seq,
    );
  if (!event) throw new Error("Missing comment event");
  f.skipEvents();
  const note = f.store.recordNotification({
    project_id: f.project,
    event_id: event.id,
    card_id: other.card.id,
    seq: event.seq,
    recipient: { kind: "assignment", assignment_id: f.target.assignment.id },
    kind: "comment",
  }).notification;
  return { event, note };
}

test.each(["pending", "belled", "delivery_failed", "needs_attention"] as const)(
  "legacy %s notifications resolve without an ACK or another wake, including after restart",
  async (status) => {
    const { note } = legacy();
    if (status !== "pending")
      f.store.moveNotification({
        project_id: f.project,
        id: note.id,
        event:
          status === "belled"
            ? "bell"
            : status === "delivery_failed"
              ? "deliver_failed"
              : "needs_attention",
        patch: {
          attempts: 5,
          run_id: f.latest().id,
          next_attempt_at: f.clock.now(),
        },
      });
    const cursors = f.state().cursors;
    await new Dispatcher(f.options).tick();
    expect(f.notes()[0]?.status).toBe("resolved");
    expect(f.state().cursors).toEqual(cursors);
    expect(f.runtime.wake).not.toHaveBeenCalled();
    expect(f.options.startRun).not.toHaveBeenCalled();
    const reopened = Store.open({ dataDir: f.dataDir });
    try {
      await new Dispatcher({ ...f.options, store: reopened }).tick();
    } finally {
      reopened.close();
    }
    const events = f
      .state()
      .events.filter((e) => e.type === "notification_resolved");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      notification_id: note.id,
      reason: "recipient_cannot_read_card",
      previous_status: status,
    });
    expect(f.runtime.wake).not.toHaveBeenCalled();
    expect(
      f.state().events.filter((e) => e.type === "bell_retry_exhausted"),
    ).toEqual([]);
  },
);

test("notification retirement and its audit roll back together", () => {
  const { note } = legacy();
  f.store.database.exec(`CREATE TEMP TRIGGER fail_retirement BEFORE INSERT ON events
    WHEN NEW.type = 'notification_resolved' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
  expect(() =>
    resolveUnreadableNotifications(f.store, f.project, f.clock),
  ).toThrow(/audit unavailable/);
  expect(f.notes()[0]?.status).toBe("pending");
  f.store.database.exec("DROP TRIGGER fail_retirement");
  expect(resolveUnreadableNotifications(f.store, f.project, f.clock)).toBe(1);
  expect(f.notes()[0]).toMatchObject({ id: note.id, status: "resolved" });
});

function failedLegacyRun() {
  const { event, note } = legacy();
  const run = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: f.target.assignment.id,
        trigger_event_id: event.id,
        kind: "followup",
        model: "fixture",
        agent_cli_version: "fixture",
      },
      p,
    ),
  );
  f.apply((s, a, p) => dispatchRun(s, a, { run_id: run.id }, p));
  f.store.uow.run(() => {
    beginBellAttempt(f.store.database, {
      id: "legacy-attempt",
      project_id: f.project,
      assignment_id: f.target.assignment.id,
      run_id: run.id,
      notification_ids: [note.id],
      started_at: f.clock.now(),
      lease_until: new Date(Date.parse(f.clock.now()) + 60000).toISOString(),
    });
    finishBellAttempt(
      f.store.database,
      f.project,
      "legacy-attempt",
      "failed",
      f.clock.now(),
    );
  });
  f.store.moveNotification({
    project_id: f.project,
    id: note.id,
    event: "deliver_failed",
    patch: { run_id: run.id, attempts: 1 },
  });
  return { run, note };
}

test("failed cross-card delivery stops safely at timeout without a replacement Run or wake after restart", async () => {
  const { run } = failedLegacyRun();
  const token = f.store.issueToken({
    project_id: f.project,
    assignment_id: run.assignment_id,
    role: { role_version: 1, allowed_tools: ["whoami"] },
  });
  const before = f.state();
  f.advance(30000);
  await new Dispatcher(f.options).tick();
  expect(f.notes()[0]?.status).toBe("resolved");
  expect(f.runtime.wake).not.toHaveBeenCalled();
  expect(listBellAttempts(f.store.database, f.project)).toHaveLength(1);
  f.advance(600000);
  await new Dispatcher(f.options).tick();
  expect(f.runtime.release).toHaveBeenCalledOnce();
  expect(f.store.verifyToken(token.token)).toBeUndefined();
  expect(f.latest()).toMatchObject({
    id: run.id,
    status: "cancelled",
    outcome: "failed",
  });
  expect(f.latest().dispatch_stop).toBeUndefined();
  expect(f.state().runs).toHaveLength(before.runs.length);
  expect(f.state().work_items).toEqual(before.work_items);
  expect(f.state().cursors).toEqual(before.cursors);
  expect(
    f.state().events.filter((e) => e.type === "run_dispatch_recovered"),
  ).toEqual([]);
  expect(
    f
      .state()
      .events.filter((e) => e.type === "run_unreadable_trigger_cancelled"),
  ).toHaveLength(1);
  const reopened = Store.open({ dataDir: f.dataDir });
  try {
    f.advance(600000);
    await new Dispatcher({ ...f.options, store: reopened }).tick();
  } finally {
    reopened.close();
  }
  expect(f.runtime.wake).not.toHaveBeenCalled();
  expect(f.options.startRun).not.toHaveBeenCalled();
  expect(f.runtime.release).toHaveBeenCalledOnce();
});

test.each(["concurrency_limit", "runtime_unavailable", undefined] as const)(
  "unreadable queued work is cancelled before dispatch (queue_reason=%s), preserving the idle session",
  async (queue_reason) => {
    const { event, note } = legacy();
    const run = f.apply((s, a, p) =>
      queueRun(
        s,
        a,
        {
          assignment_id: f.target.assignment.id,
          trigger_event_id: event.id,
          kind: "followup",
          model: "fixture",
          agent_cli_version: "fixture",
        },
        p,
      ),
    );
    if (queue_reason)
      f.store.uow.run((tx) => tx.runs.put(f.project, { ...run, queue_reason }));
    // Retirement in an earlier tick must not erase the evidence needed to cancel the Run.
    resolveUnreadableNotifications(f.store, f.project, f.clock);
    const before = f.state();
    await new Dispatcher(f.options).tick();
    expect(f.latest()).toMatchObject({
      id: run.id,
      status: "cancelled",
      outcome: "failed",
    });
    expect(f.latest().queue_reason).toBeUndefined();
    expect(
      f
        .state()
        .assignments.map(
          ({ session_maintenance: _diagnostic, ...identity }) => identity,
        ),
    ).toEqual(before.assignments);
    expect(f.state().work_items).toEqual(before.work_items);
    expect(f.state().cursors).toEqual(before.cursors);
    expect(f.runtime.status).not.toHaveBeenCalled();
    expect(f.runtime.release).not.toHaveBeenCalled();
    expect(f.runtime.wake).not.toHaveBeenCalled();
    expect(f.options.startRun).not.toHaveBeenCalled();
    expect(f.notes().find((n) => n.id === note.id)?.status).toBe("resolved");
    await new Dispatcher(f.options).tick();
    expect(
      f
        .state()
        .events.filter((e) => e.type === "run_unreadable_trigger_cancelled"),
    ).toHaveLength(1);
    // Subsequent real work still uses the preserved session and can start normally.
    f.comment();
    await new Dispatcher(f.options).tick();
    expect(f.runtime.wake).toHaveBeenCalledOnce();
    expect(f.latest()).toMatchObject({ status: "dispatched" });
    expect(f.latest().id).not.toBe(run.id);
  },
);

test("an unconfirmed stop preserves capacity and credentials until exit is proven after restart", async () => {
  const { run } = failedLegacyRun();
  const token = f.store.issueToken({
    project_id: f.project,
    assignment_id: run.assignment_id,
    role: { role_version: 1, allowed_tools: ["whoami"] },
  });
  const release = vi.mocked(f.runtime.release).getMockImplementation();
  if (!release) throw new Error("Missing release fixture");
  vi.mocked(f.runtime.release).mockResolvedValue({
    ok: false,
    error: { code: "runtime_timeout", message: "unconfirmed" },
  });
  f.advance(600000);
  await new Dispatcher(f.options).tick();
  expect(f.latest()).toMatchObject({
    id: run.id,
    status: "dispatched",
    dispatch_stop: { stopping: true },
  });
  expect(f.store.verifyToken(token.token)).toBeDefined();
  expect(occupiedRunSlots(f.state().assignments, f.state().runs, "local")).toBe(
    1,
  );
  expect(f.runtime.wake).not.toHaveBeenCalled();
  expect(f.options.startRun).not.toHaveBeenCalled();
  vi.mocked(f.runtime.release).mockImplementation(release);
  f.advance(60001);
  const reopened = Store.open({ dataDir: f.dataDir });
  try {
    await new Dispatcher({ ...f.options, store: reopened }).tick();
  } finally {
    reopened.close();
  }
  expect(f.latest()).toMatchObject({ id: run.id, status: "cancelled" });
  expect(f.latest().dispatch_stop).toBeUndefined();
  expect(occupiedRunSlots(f.state().assignments, f.state().runs, "local")).toBe(
    0,
  );
  expect(f.store.verifyToken(token.token)).toBeUndefined();
  expect(
    f.state().events.filter((e) => e.type === "run_dispatch_recovered"),
  ).toEqual([]);
  expect(f.options.startRun).not.toHaveBeenCalled();
});

test("MCP start wins over obsolete comment cleanup and timeout recovery", async () => {
  const { run } = failedLegacyRun();
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
    f.actorFor(f.target.assignment),
  );
  const before = f.state();
  f.advance(600000);
  await new Dispatcher(f.options).tick();
  expect(f.latest()).toMatchObject({ id: run.id, status: "running" });
  expect(f.state().runs).toEqual(before.runs);
  expect(f.state().work_items).toEqual(before.work_items);
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.runtime.wake).not.toHaveBeenCalled();
  expect(f.options.startRun).not.toHaveBeenCalled();
});

test("an in-flight queued launch is fenced from cleanup until its delivery settles", async () => {
  const { event, note } = legacy();
  const run = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: f.target.assignment.id,
        trigger_event_id: event.id,
        kind: "followup",
        model: "fixture",
        agent_cli_version: "fixture",
      },
      p,
    ),
  );
  f.store.uow.run((tx) => {
    tx.runs.put(f.project, { ...run, queue_reason: "concurrency_limit" });
    beginBellAttempt(f.store.database, {
      id: "in-flight",
      project_id: f.project,
      assignment_id: run.assignment_id,
      run_id: run.id,
      notification_ids: [note.id],
      started_at: f.clock.now(),
      lease_until: new Date(Date.parse(f.clock.now()) + 60000).toISOString(),
    });
  });
  await new Dispatcher(f.options).tick();
  expect(f.latest()).toMatchObject({ id: run.id, status: "queued" });
  expect(f.runtime.wake).not.toHaveBeenCalled();
  expect(f.runtime.release).not.toHaveBeenCalled();
  f.apply((s, a, p) => dispatchRun(s, a, { run_id: run.id }, p));
  f.store.uow.run(() =>
    finishBellAttempt(
      f.store.database,
      f.project,
      "in-flight",
      "sent",
      f.clock.now(),
    ),
  );
  f.apply(
    (s, a, p) => acknowledgeRun(s, a, { run_id: run.id }, p),
    f.actorFor(f.target.assignment),
  );
  await new Dispatcher(f.options).tick();
  expect(f.latest()).toMatchObject({ id: run.id, status: "running" });
  expect(f.runtime.release).not.toHaveBeenCalled();
  expect(f.options.startRun).not.toHaveBeenCalled();
});

test("same-card, standing, project-stream and acknowledged notifications are preserved", () => {
  const { note, event } = legacy();
  f.store.moveNotification({
    project_id: f.project,
    id: note.id,
    event: "ack",
  });
  const pm = f.pm();
  const own = f.comment();
  routeProjectEvents(f.store, f.project);
  for (const input of [
    {
      recipient: { kind: "assignment" as const, assignment_id: pm.id },
      card_id: event.card_id,
    },
    {
      recipient: {
        kind: "assignment" as const,
        assignment_id: f.target.assignment.id,
      },
    },
  ]) {
    const source = f.store.uow.run((tx) => {
      const source = {
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(f.project, input.card_id),
        ...(input.card_id ? { card_id: input.card_id } : {}),
        type: "fixture_notice",
        actor: { kind: "system" as const, project_id: f.project },
        payload: {},
        created_at: f.clock.now(),
      };
      tx.events.append(f.project, source);
      return source;
    });
    f.store.recordNotification({
      project_id: f.project,
      event_id: source.id,
      seq: source.seq,
      kind: "comment",
      ...input,
    });
  }
  const before = f.store.listNotifications({ project_id: f.project });
  expect(
    before.some((n) => n.card_id === own.card_id && n.seq === own.event_seq),
  ).toBe(true);
  expect(resolveUnreadableNotifications(f.store, f.project, f.clock)).toBe(0);
  expect(f.store.listNotifications({ project_id: f.project })).toEqual(before);
});
