import { createCard, type NotificationRecipient } from "@cardigan/domain";
import {
  advanceRouterCursor,
  PROJECT_EVENT_STREAM,
  recordNotification,
  Store,
} from "@cardigan/store";
import { afterEach, beforeEach, expect, test } from "vitest";
import { m3Fixture } from "../test-support/m3-acceptance.js";

let f: ReturnType<typeof m3Fixture>;
beforeEach(() => {
  f = m3Fixture();
});
afterEach(() => f.close());
const input = (
  e = f.comment(),
  recipient: NotificationRecipient = {
    kind: "assignment",
    assignment_id: f.coder.id,
  },
) => ({
  project_id: f.id,
  event_id: e.id,
  card_id: e.card_id,
  seq: e.seq,
  kind: "comment",
  recipient,
});
const notes = () => f.store.listNotifications({ project_id: f.id });

test("[S01] M3.3 replay preserves one event/recipient row and its existing state", () => {
  const p = input(),
    first = f.store.recordNotification(p).notification;
  f.store.moveNotification({
    project_id: f.id,
    id: first.id,
    event: "bell",
    patch: { attempts: 1 },
  });
  const replay = f.store.recordNotification({ ...p, kind: "instruction" });
  expect(replay.created).toBe(false);
  expect(replay.notification).toMatchObject({
    id: first.id,
    kind: "comment",
    status: "belled",
    attempts: 1,
  });
  expect(notes()).toHaveLength(1);
});
test("[S02] M3.3 one event can independently address every recipient kind", () => {
  const e = f.comment(),
    recipients: NotificationRecipient[] = [
      { kind: "assignment", assignment_id: f.coder.id },
      { kind: "assignment", assignment_id: f.reviewer.id },
      { kind: "pm_ops" },
      { kind: "pm_office" },
      { kind: "needs_you" },
    ];
  for (const to of recipients) {
    const p = input(e, to);
    expect(f.store.recordNotification(p).created).toBe(true);
    expect(f.store.recordNotification(p).created).toBe(false);
  }
  expect(notes().map((n) => n.recipient)).toEqual(
    expect.arrayContaining(recipients),
  );
  expect(notes()).toHaveLength(5);
});
test("[S03] M3.3 inbox reads retain stream seq order despite reverse insertion", () => {
  const a = f.comment(),
    b = f.comment();
  f.store.recordNotification(input(b));
  f.store.recordNotification(input(a));
  expect(notes().map((n) => n.event_id)).toEqual([a.id, b.id]);
});
test("[S04] M3.3 recipient grouping includes pending/belled and excludes failed/terminal notices", () => {
  for (const event of [
    undefined,
    "bell",
    "deliver_failed",
    "ack",
    "needs_attention",
  ] as const) {
    const n = f.store.recordNotification(input()).notification;
    if (event) f.store.moveNotification({ project_id: f.id, id: n.id, event });
  }
  f.store.recordNotification(input(f.comment(), { kind: "pm_ops" }));
  const groups = [...f.store.notificationsByRecipient(f.id).values()];
  expect(groups.map((g) => g.length).sort()).toEqual([1, 2]);
  expect(
    groups.flat().every((n) => ["pending", "belled"].includes(n.status)),
  ).toBe(true);
});
test("[S05] M3.3 ACK only confirms this Assignment/card through the acknowledged seq, including late delivery failure", () => {
  const a = f.comment(),
    b = f.comment(),
    first = f.store.recordNotification(input(a)).notification;
  f.store.moveNotification({
    project_id: f.id,
    id: first.id,
    event: "deliver_failed",
  });
  const later = f.store.recordNotification(input(b)).notification,
    other = f.store.recordNotification(
      input(a, { kind: "assignment", assignment_id: f.reviewer.id }),
    ).notification;
  expect(
    f.store.ackEvents({
      project_id: f.id,
      assignment_id: f.coder.id,
      card_id: f.card.id,
      up_to_seq: a.seq,
    }).ok,
  ).toBe(true);
  f.store.acknowledgeNotifications(f.id, f.coder.id);
  expect(notes().find((n) => n.id === first.id)?.status).toBe("acked");
  for (const n of [later, other])
    expect(notes().find((v) => v.id === n.id)?.status).toBe("pending");
});
// §4.4 makes needs_attention terminal; ACK reconciliation should skip it. The current API tries ack and throws.
test.fails("[S06] M3.3 ACK reconciliation leaves escalated terminal notifications unchanged", () => {
  const e = f.comment(),
    n = f.store.recordNotification(input(e)).notification;
  f.store.moveNotification({
    project_id: f.id,
    id: n.id,
    event: "needs_attention",
  });
  expect(
    f.store.ackEvents({
      project_id: f.id,
      assignment_id: f.coder.id,
      card_id: f.card.id,
      up_to_seq: e.seq,
    }).ok,
  ).toBe(true);
  expect(() =>
    f.store.acknowledgeNotifications(f.id, f.coder.id),
  ).not.toThrow();
  expect(notes()[0]?.status).toBe("needs_attention");
});
test("[S07] M3.3 card/project streams and identical card ids in other projects have independent cursors", () => {
  const card = f.apply((s, a, p) =>
    createCard(
      s,
      a,
      {
        title: "Second card",
        goal: "Separate stream",
        acceptance_criteria: ["isolated"],
        repo: "fixture/repo",
        base_branch: "main",
        source: { kind: "quote", text: "second" },
      },
      p,
    ),
  ).data;
  const other = m3Fixture("other-project", f.store);
  f.store.advanceRouterCursor(f.id, f.card.id, 99);
  f.store.advanceRouterCursor(f.id, card.id, 1);
  f.store.advanceRouterCursor(f.id, PROJECT_EVENT_STREAM, 2);
  f.store.advanceRouterCursor(other.id, other.card.id, 3);
  expect([
    f.store.routerCursor(f.id, f.card.id),
    f.store.routerCursor(f.id, card.id),
    f.store.routerCursor(f.id, PROJECT_EVENT_STREAM),
    f.store.routerCursor(other.id, other.card.id),
    f.store.routerCursor(other.id, PROJECT_EVENT_STREAM),
  ]).toEqual([99, 1, 2, 3, 0]);
});
test("[S08] M3.3 stream cursors never regress", () => {
  for (const seq of [7, 7, 2])
    f.store.advanceRouterCursor(f.id, f.card.id, seq);
  expect(f.store.routerCursor(f.id, f.card.id)).toBe(7);
});
test("[S09] M3.3 notifications and cursor roll back together, then commit together on replay", () => {
  const p = input(),
    write = () => {
      recordNotification(f.store.database, p);
      advanceRouterCursor(f.store.database, f.id, f.card.id, p.seq);
    };
  expect(() =>
    f.store.uow.run(() => {
      write();
      throw new Error("abort page");
    }),
  ).toThrow("abort page");
  expect(notes()).toEqual([]);
  expect(f.store.routerCursor(f.id, f.card.id)).toBe(0);
  f.store.uow.run(write);
  expect(notes()).toHaveLength(1);
  expect(f.store.routerCursor(f.id, f.card.id)).toBe(p.seq);
});
test("[S10] M3.3 reopening the database preserves replay uniqueness and each stream cursor", () => {
  const p = input();
  f.store.recordNotification(p);
  f.store.advanceRouterCursor(f.id, f.card.id, p.seq);
  if (!f.dataDir) throw new Error("Missing owned test directory");
  const reopened = Store.open({ dataDir: f.dataDir });
  try {
    expect(reopened.recordNotification(p).created).toBe(false);
    expect(reopened.listNotifications({ project_id: f.id })).toHaveLength(1);
    expect(reopened.routerCursor(f.id, f.card.id)).toBe(p.seq);
    expect(reopened.routerCursor(f.id, PROJECT_EVENT_STREAM)).toBe(0);
  } finally {
    reopened.close();
  }
});
