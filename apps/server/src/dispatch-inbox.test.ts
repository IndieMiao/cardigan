import { postComment, queueRun } from "@cardigan/domain";
import * as router from "@cardigan/router";
import {
  beginBellAttempt,
  getRoleVersion,
  PROJECT_EVENT_STREAM,
  Store,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchFixture } from "../test-support/dispatch.js";
import {
  acknowledgeInbox,
  routeProjectEvents,
  routeStreamEvents,
} from "./dispatch-inbox.js";

let f: ReturnType<typeof dispatchFixture>;
beforeEach(() => {
  f = dispatchFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  f.close();
});
const comment = (target: ReturnType<typeof f.create>, body = "Please check") =>
  f.apply((s, a, p) =>
    postComment(
      s,
      a,
      { card_id: target.card.id, work_item_id: target.item.id, body },
      p,
    ),
  );
// These scenarios exercise comments/escalations; new-card routing has its own
// rotation tests in card-planning.test.ts.
const notes = () =>
  f.store
    .listNotifications({ project_id: f.project })
    .filter((n) => n.kind !== "card");

test("idle routing avoids empty write transactions and observes a later connection's event", () => {
  const target = f.create();
  while (routeProjectEvents(f.store, f.project)) {
    /* drain */
  }
  const exec = vi.spyOn(f.store.database, "exec");
  expect(routeProjectEvents(f.store, f.project)).toBe(0);
  expect(exec.mock.calls.some(([sql]) => sql === "BEGIN IMMEDIATE")).toBe(
    false,
  );
  exec.mockRestore();
  const writer = Store.open({ dataDir: f.dataDir });
  try {
    writer.uow.run((tx) =>
      tx.events.append(f.project, {
        id: tx.ids.nextEventId(),
        card_id: target.card.id,
        seq: tx.ids.nextEventSequence(f.project, target.card.id),
        type: "comment_posted",
        actor: { kind: "human", project_id: f.project },
        payload: { body: "new event", work_item_id: target.item.id },
        created_at: f.clock.now(),
      }),
    );
    expect(routeProjectEvents(f.store, f.project)).toBeGreaterThan(0);
    expect(routeProjectEvents(f.store, f.project)).toBe(0);
  } finally {
    writer.close();
  }
});

test("high card seq does not hide a new card or project events, including after restart", () => {
  const older = f.create();
  for (let i = 0; i < 12; i++) comment(older, `older ${i}`);
  routeProjectEvents(f.store, f.project);
  const high = f.store.routerCursor(f.project, older.card.id);
  const newer = f.create();
  comment(newer, "new card");
  const projectEvent = f.store.uow.run((tx) => {
    const event = {
      id: tx.ids.nextEventId(),
      seq: tx.ids.nextEventSequence(f.project),
      type: "delivery_submitted",
      actor: { kind: "human" as const, project_id: f.project },
      payload: { delivery_id: "D-missing" },
      created_at: f.clock.now(),
    };
    tx.events.append(f.project, event);
    return event;
  });
  while (routeProjectEvents(f.store, f.project, { batchSize: 1 })) {
    /* one event per stream */
  }
  expect(f.store.routerCursor(f.project, older.card.id)).toBe(high);
  const latest = f.store.getUpdates({
    project_id: f.project,
    card_id: newer.card.id,
  }).latest_seq;
  expect(f.store.routerCursor(f.project, newer.card.id)).toBe(latest);
  expect(latest).toBeLessThan(high);
  expect(f.store.routerCursor(f.project, PROJECT_EVENT_STREAM)).toBe(
    projectEvent.seq,
  );
  expect(notes().filter((n) => n.card_id === newer.card.id)).toHaveLength(1);
  expect(notes().find((n) => n.event_id === projectEvent.id)).toMatchObject({
    recipient: { kind: "pm_ops" },
    seq: 1,
  });
  expect(notes().filter((n) => n.card_id === older.card.id)).toHaveLength(12);
  const reopened = Store.open({ dataDir: f.dataDir });
  try {
    expect(routeProjectEvents(reopened, f.project)).toBe(0);
    expect(reopened.listNotifications({ project_id: f.project })).toEqual(
      f.store.listNotifications({ project_id: f.project }),
    );
  } finally {
    reopened.close();
  }
});
test("a failed inbox write rolls back the whole page and its cursor", () => {
  const target = f.create();
  routeProjectEvents(f.store, f.project);
  const before = f.store.routerCursor(f.project, target.card.id);
  comment(target, "one");
  comment(target, "two");
  f.store.database.exec(`CREATE TEMP TRIGGER fail_page BEFORE INSERT ON notifications
    WHEN (SELECT count(*) FROM notifications WHERE json_extract(doc, '$.kind') != 'card') >= 1 BEGIN SELECT RAISE(ABORT, 'inbox unavailable'); END;`);
  expect(() => routeProjectEvents(f.store, f.project)).toThrow(
    /inbox unavailable/,
  );
  expect(notes()).toEqual([]);
  expect(f.store.routerCursor(f.project, target.card.id)).toBe(before);
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

test.each([false, true])(
  "logical PM ACK uses the in-flight receiver even if the configured PM changes (project stream=%s)",
  (projectStream) => {
    const target = f.create();
    if (projectStream)
      f.store.uow.run((tx) =>
        tx.events.append(f.project, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(f.project),
          type: "reconcile_finding",
          actor: { kind: "system", project_id: f.project },
          payload: { kind: "orphan_worktree", path: "/fixture/unowned" },
          created_at: f.clock.now(),
        }),
      );
    else
      f.apply((s, a, p) =>
        postComment(s, a, { card_id: target.card.id, body: "For Ops" }, p),
      );
    routeProjectEvents(f.store, f.project);
    const note = notes().find((n) => n.recipient.kind === "pm_ops");
    if (!note) throw new Error("Missing PM notification");
    const owners = f.store.uow.run((tx) => {
      // f.create() registered the PM role; this scenario replaces its Assignment.
      const role = getRoleVersion(tx, f.project, "pm");
      if (!role) throw new Error("Missing PM role");
      return [0, 1].map(() => {
        const id = tx.ids.next(f.project, "assignment");
        tx.assignments.put(f.project, {
          id,
          scope: "standing",
          role_id: "pm",
          role_version: role.version,
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
      card_id: projectStream ? PROJECT_EVENT_STREAM : target.card.id,
      up_to_seq: note.seq,
    });
    // A pending new-card notice follows the current Ops cursor; the comment
    // pinned to an in-flight delivery still belongs to its original receiver.
    expect(acknowledgeInbox(f.store, f.project, () => replacement)).toBe(
      projectStream ? 0 : 1,
    );
    expect(notes().find((n) => n.id === note.id)?.status).toBe("pending");
    f.store.ackEvents({
      project_id: f.project,
      assignment_id: original,
      card_id: projectStream ? PROJECT_EVENT_STREAM : target.card.id,
      up_to_seq: note.seq,
    });
    expect(acknowledgeInbox(f.store, f.project, () => replacement)).toBe(1);
    expect(notes().find((n) => n.id === note.id)?.status).toBe("acked");
  },
);

test("stream pages commit independently and preserve seq order inside each stream", () => {
  const routed = vi.spyOn(router, "routeEvent");
  const a = f.create(),
    b = f.create();
  comment(b, "B1");
  comment(a, "A1");
  comment(b, "B2");
  comment(a, "A2");
  routeStreamEvents(f.store, f.project, b.card.id);
  const bSeqs = routed.mock.calls.map(([input]) => input.event.seq);
  expect(bSeqs).toEqual([...bSeqs].sort((x, y) => x - y));
  expect(f.store.routerCursor(f.project, a.card.id)).toBe(0);
  const bCursor = f.store.routerCursor(f.project, b.card.id);
  f.store.database.exec(`CREATE TEMP TRIGGER fail_stream BEFORE INSERT ON notifications
    WHEN NEW.card_id != '${b.card.id}' AND (SELECT count(*) FROM notifications WHERE card_id = NEW.card_id) >= 1
    BEGIN SELECT RAISE(ABORT, 'stream unavailable'); END;`);
  expect(() => routeStreamEvents(f.store, f.project, a.card.id)).toThrow(
    /stream unavailable/,
  );
  expect(f.store.routerCursor(f.project, a.card.id)).toBe(0);
  expect(f.store.routerCursor(f.project, b.card.id)).toBe(bCursor);
  expect(notes()).toHaveLength(2);
  f.store.database.exec("DROP TRIGGER fail_stream");
  routed.mockClear();
  routeStreamEvents(f.store, f.project, a.card.id);
  const aSeqs = routed.mock.calls.map(([input]) => input.event.seq);
  expect(aSeqs).toEqual([...aSeqs].sort((x, y) => x - y));
  for (const { card } of [a, b]) {
    const seqs = notes()
      .filter((n) => n.card_id === card.id)
      .map((n) => n.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(f.store.routerCursor(f.project, card.id)).toBe(seqs.at(-1));
  }
});
