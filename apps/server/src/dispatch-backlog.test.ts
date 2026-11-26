import {
  type CardId,
  createCard,
  type Event,
  type Notification,
} from "@cardigan/domain";
import { recordNotification } from "@cardigan/store";
import { afterEach, expect, test } from "vitest";
import { recoveryFixture } from "../test-support/recovery.js";
import { Dispatcher } from "./dispatch.js";
import {
  acknowledgeInbox,
  listAttentionCandidates,
  resolveUnreadableNotifications,
} from "./dispatch-inbox.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

/** C-788: an external Office plus owner notices nobody consumes in the loop. */
function backlog(cards: number) {
  const f = recoveryFixture();
  cleanup.push(() => f.close());
  const legacy = f.pm();
  const office = f.store.uow.run((tx) => {
    const a = {
      ...legacy,
      id: tx.ids.next(f.project, "assignment"),
      standing_mode: "office" as const,
      external: true,
    };
    tx.assignments.put(f.project, a);
    return a;
  });
  const ids: CardId[] = [];
  for (let i = 0; i < cards; i++)
    ids.push(
      f.apply((s, a, p) =>
        createCard(
          s,
          a,
          {
            title: `Backlog ${i}`,
            goal: "backlog",
            acceptance_criteria: ["x"],
            repo: "fixture/repo",
            base_branch: "main",
            source: { kind: "quote", text: "backlog" },
          },
          p,
        ),
      ).id,
    );
  f.skipEvents();
  const recipients: Notification["recipient"][] = [
    { kind: "assignment", assignment_id: office.id },
    { kind: "pm_office" },
    { kind: "needs_you" },
  ];
  const rows: string[] = [];
  f.store.uow.run((tx) => {
    for (const card of ids)
      for (const recipient of recipients) {
        const e = {
          type: "comment_posted",
          payload: { body: "backlog" },
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(f.project, card),
          card_id: card,
          created_at: f.clock.now(),
          actor: { kind: "system" as const, project_id: f.project },
        };
        tx.events.append(f.project, e);
        rows.push(
          recordNotification(f.store.database, {
            project_id: f.project,
            event_id: e.id,
            card_id: card,
            seq: e.seq,
            at: e.created_at,
            kind: "comment",
            recipient,
          }).notification.id,
        );
      }
  });
  f.skipEvents();
  // Past the dispatch timeout: every row is an overdue standing-inbox row.
  f.advance(11 * 60_000);
  const standing = (_p: string, kind: string) =>
    kind === "pm_office" ? office.id : undefined;
  const dispatcher = new Dispatcher({ ...f.options, standing });
  cleanup.push(() => void dispatcher.close());
  const counts = { reads: 0, writes: 0 };
  f.store.observe({
    transaction: (kind) => {
      if (kind === "read") counts.reads++;
    },
    writeLock: () => {
      counts.writes++;
    },
  });
  const measure = async () => {
    counts.reads = 0;
    counts.writes = 0;
    f.advance(1_000);
    await dispatcher.tick();
    return { ...counts };
  };
  /** The backlog rows, as they are now. */
  const backlogRows = () =>
    f.store.listNotifications({ project_id: f.project, ids: rows });
  return { ...f, office, ids, dispatcher, measure, backlogRows, standing };
}

test("C-788: an unconsumed external Office and owner backlog costs no transactions per row", async () => {
  const small = backlog(3);
  const large = backlog(30);
  for (const f of [small, large]) {
    await f.measure();
    await f.measure();
  }
  const [a, b] = [await small.measure(), await large.measure()];
  // The external Office's 30 candidate streams open neither a read for
  // delivery nor a write for the standing-inbox check.
  expect(b).toEqual(a);
  for (const f of [small, large])
    expect(f.backlogRows().map((n) => n.status)).toEqual(
      Array(f.ids.length * 3).fill("pending"),
    );
});

test("C-788: owner notices and the external Office inbox stay unread; nothing is confirmed by age", async () => {
  const f = backlog(5);
  for (let i = 0; i < 4; i++) {
    f.advance(24 * 60 * 60_000);
    await f.measure();
  }
  const rows = f.backlogRows();
  expect(rows.filter((n) => n.recipient.kind === "needs_you")).toHaveLength(5);
  expect(rows.map((n) => n.status)).toEqual(Array(15).fill("pending"));
  expect(
    f
      .state()
      .events.filter(
        (e) =>
          e.type === "notification_resolved" ||
          e.type === "standing_inbox_stalled",
      ),
  ).toEqual([]);
});

test("C-788: backlog rows still ACK once their owner's cursor covers them", async () => {
  const f = backlog(2);
  const [first, second] = f.ids;
  const notes = (card: CardId | undefined) =>
    f.store.listNotifications({ project_id: f.project, card_id: card });
  const covered = notes(first);
  expect(
    f.store.ackEvents({
      project_id: f.project,
      assignment_id: f.office.id,
      card_id: first as CardId,
      up_to_seq: Math.max(...covered.map((n) => n.seq)),
    }).ok,
  ).toBe(true);
  // The direct row and the role row resolved to the Office ACK; the owner's
  // notice has no owner and stays unread.
  expect(
    acknowledgeInbox(f.store, f.project, f.standing as never, f.clock),
  ).toBe(2);
  expect(notes(first).map((n) => [n.recipient.kind, n.status])).toEqual([
    ["assignment", "acked"],
    ["pm_office", "acked"],
    ["needs_you", "pending"],
  ]);
  expect(notes(second).every((n) => n.status === "pending")).toBe(true);
  expect(acknowledgeInbox(f.store, f.project, f.standing as never)).toBe(0);
});

test("C-788: the narrowed scans still return every row their predicates can match", () => {
  const f = backlog(1);
  const card = f.ids[0] as CardId;
  const add = (
    type: string,
    payload: Event["payload"],
    recipient: Notification["recipient"],
  ) =>
    f.store.uow.run((tx) => {
      const e: Event = {
        type,
        payload,
        id: tx.ids.nextEventId(),
        seq: tx.ids.nextEventSequence(f.project, card),
        card_id: card,
        created_at: f.clock.now(),
        actor: { kind: "system" as const, project_id: f.project },
      };
      tx.events.append(f.project, e);
      return recordNotification(f.store.database, {
        project_id: f.project,
        event_id: e.id,
        card_id: card,
        seq: e.seq,
        at: e.created_at,
        kind: "comment",
        recipient,
      }).notification;
    });
  const diagnostic = add(
    "run_inactive",
    { run_id: "R-1", assignment_id: "A-1" },
    { kind: "pm_ops" },
  );
  const action = add(
    "human_action_requested",
    { human_action_id: "H-1" },
    { kind: "needs_you" },
  );
  const reminder = add(
    "human_action_reminder",
    { reminders: [{ human_action_id: "H-1" }] },
    { kind: "needs_you" },
  );
  const failed = add("comment_posted", {}, { kind: "pm_ops" });
  f.store.moveNotification({
    project_id: f.project,
    id: failed.id,
    event: "bell",
    patch: { run_id: "R-9" as never },
  });
  const ids = listAttentionCandidates(f.store, f.project).map((n) => n.id);
  expect(ids).toEqual([diagnostic.id, action.id, reminder.id, failed.id]);
  // Rows for standing Assignments are never unreadable; no scan, no change.
  expect(resolveUnreadableNotifications(f.store, f.project, f.clock)).toBe(0);
});
