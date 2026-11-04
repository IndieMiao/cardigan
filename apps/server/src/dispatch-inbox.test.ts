import { postComment, queueRun } from "@cardigan/domain";
import {
  beginBellAttempt,
  getRoleVersion,
  projectEvents,
  Store,
  writeRole,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import { acknowledgeInbox, routeProjectEvents } from "./dispatch-inbox.js";

let f: ReturnType<typeof dispatchFixture>;
beforeEach(() => {
  f = dispatchFixture();
});
afterEach(() => f.close());
const comment = (target: ReturnType<typeof f.create>, body = "Please check") =>
  f.apply((s, a, p) =>
    postComment(
      s,
      a,
      { card_id: target.card.id, work_item_id: target.item.id, body },
      p,
    ),
  );
const notes = () => f.store.listNotifications({ project_id: f.project });

test("consumes all card streams through the project cursor and is restart-idempotent", () => {
  const a = f.create(),
    b = f.create();
  comment(a);
  comment(b);
  comment(a);
  const events = projectEvents(f.store.database, f.project, 0);
  while (
    routeProjectEvents(f.store, f.project, { clock: f.clock, batchSize: 2 })
  ) {
    /* bounded pages */
  }
  expect(notes().map((n) => n.recipient)).toEqual(
    expect.arrayContaining([
      { kind: "assignment", assignment_id: a.assignment.id },
      { kind: "assignment", assignment_id: b.assignment.id },
    ]),
  );
  expect(notes()).toHaveLength(3);
  expect(f.store.routerCursor(f.project)).toBe(events.at(-1)?.position);
  const reopened = Store.open({ dataDir: f.dataDir });
  try {
    expect(routeProjectEvents(reopened, f.project)).toBe(0);
    expect(reopened.listNotifications({ project_id: f.project })).toEqual(
      notes(),
    );
  } finally {
    reopened.close();
  }
});
test("a failed inbox write rolls back the whole page and its cursor", () => {
  const target = f.create();
  routeProjectEvents(f.store, f.project);
  const before = f.store.routerCursor(f.project);
  comment(target, "one");
  comment(target, "two");
  f.store.database.exec(`CREATE TEMP TRIGGER fail_page BEFORE INSERT ON notifications
    WHEN (SELECT count(*) FROM notifications) >= 1 BEGIN SELECT RAISE(ABORT, 'inbox unavailable'); END;`);
  expect(() => routeProjectEvents(f.store, f.project)).toThrow(
    /inbox unavailable/,
  );
  expect(notes()).toEqual([]);
  expect(f.store.routerCursor(f.project)).toBe(before);
  f.store.database.exec("DROP TRIGGER fail_page");
  routeProjectEvents(f.store, f.project);
  expect(notes()).toHaveLength(2);
});
test("ACK covers pending, belled and delivery_failed rows for its card; terminal attention stays terminal", () => {
  const target = f.create(),
    other = f.create();
  for (let i = 0; i < 4; i++) comment(target, `notice ${i}`);
  comment(other);
  routeProjectEvents(f.store, f.project);
  const rows = notes().filter((n) => n.card_id === target.card.id);
  const first = rows[0],
    belled = rows[1],
    failed = rows[2],
    attention = rows[3];
  if (!first || !belled || !failed || !attention)
    throw new Error("Missing notices");
  for (const [row, event] of [
    [belled, "bell"],
    [failed, "deliver_failed"],
    [attention, "needs_attention"],
  ] as const)
    f.store.moveNotification({ project_id: f.project, id: row.id, event });
  expect(
    f.store.ackEvents({
      project_id: f.project,
      assignment_id: target.assignment.id,
      card_id: target.card.id,
      up_to_seq: attention.seq,
    }).ok,
  ).toBe(true);
  expect(acknowledgeInbox(f.store, f.project, undefined, f.clock)).toBe(3);
  expect(acknowledgeInbox(f.store, f.project)).toBe(0);
  expect(notes().find((n) => n.id === failed.id)?.status).toBe("acked");
  expect(notes().find((n) => n.id === attention.id)?.status).toBe(
    "needs_attention",
  );
  expect(notes().find((n) => n.card_id === other.card.id)?.status).toBe(
    "pending",
  );
});
test("unresolved routing is retained as an Ops escalation instead of silently advancing past it", () => {
  const target = f.create();
  f.store.uow.run((tx) =>
    tx.events.append(f.project, {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(f.project, target.card.id),
      card_id: target.card.id,
      type: "delivery_submitted",
      actor: { kind: "human", project_id: f.project },
      payload: { delivery_id: "D-999" },
      created_at: f.clock.now(),
    }),
  );
  routeProjectEvents(f.store, f.project);
  expect(notes()).toEqual([
    expect.objectContaining({
      recipient: { kind: "pm_ops" },
      kind: "escalation",
      status: "pending",
    }),
  ]);
});

test("logical PM ACK uses the in-flight receiver even if the configured PM changes", () => {
  const target = f.create();
  f.apply((s, a, p) =>
    postComment(s, a, { card_id: target.card.id, body: "For Ops" }, p),
  );
  routeProjectEvents(f.store, f.project);
  const note = notes().find((n) => n.recipient.kind === "pm_ops");
  if (!note) throw new Error("Missing PM notification");
  const owners = f.store.uow.run((tx) => {
    const role = getRoleVersion(tx, f.project, "coder");
    if (!role) throw new Error("Missing role");
    writeRole(
      tx,
      f.project,
      { ...role, role_id: "pm", kind: "standing", capabilities: ["manage"] },
      { mode: "add" },
    );
    return [0, 1].map(() => {
      const id = tx.ids.next(f.project, "assignment");
      tx.assignments.put(f.project, {
        id,
        scope: "standing",
        role_id: "pm",
        role_version: 1,
        status: "active",
        runtime_state: "not_provisioned",
        runtime_ref: null,
        machine_id: "local",
        mcp_token_id: `reserved:${id}`,
        created_at: f.clock.now(),
      });
      return id;
    });
  });
  const original = owners[0],
    replacement = owners[1];
  if (!original || !replacement) throw new Error("Missing PMs");
  const run = f.apply((s, a, p) =>
    queueRun(
      s,
      a,
      {
        assignment_id: original,
        trigger_event_id: note.event_id,
        model: "fixture",
        agent_cli_version: "fixture",
      },
      p,
    ),
  );
  f.store.uow.run(() =>
    beginBellAttempt(f.store.database, {
      id: "in-flight",
      project_id: f.project,
      assignment_id: original,
      run_id: run.id,
      notification_ids: [note.id],
      started_at: f.clock.now(),
      lease_until: "2030-01-01T00:01:00.000Z",
    }),
  );
  f.store.ackEvents({
    project_id: f.project,
    assignment_id: replacement,
    card_id: target.card.id,
    up_to_seq: note.seq,
  });
  expect(acknowledgeInbox(f.store, f.project, () => replacement)).toBe(0);
  f.store.ackEvents({
    project_id: f.project,
    assignment_id: original,
    card_id: target.card.id,
    up_to_seq: note.seq,
  });
  expect(acknowledgeInbox(f.store, f.project, () => replacement)).toBe(1);
  expect(notes().find((n) => n.id === note.id)?.status).toBe("acked");
});
