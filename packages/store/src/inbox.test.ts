import type { CardId, NotificationStatus } from "@cardigan/domain";
import { expect, test } from "vitest";
import { PROJECT_EVENT_STREAM } from "./ids.js";
import {
  advanceRouterCursor,
  reassignNotifications,
  recordNotification,
} from "./inbox.js";
import { Store } from "./store.js";
import {
  assignment,
  card,
  event,
  project_id,
  withTempStore,
} from "./test-support.js";

/** M3.3: the router inbox, its state machine and the Router cursor. */

const card_id = "C-1" as CardId;
type Temp = Parameters<Parameters<typeof withTempStore>[0]>[0];

function seed(store: Temp): void {
  store.uow.run((tx) => {
    tx.cards.put(project_id, card());
    tx.assignments.put(project_id, assignment());
    // The inbox has a foreign key to `events`, so the rows must exist.
    tx.events.append(project_id, event({ seq: 1, card_id }) as never);
    tx.events.append(project_id, event({ seq: 5, card_id }) as never);
  });
}

const eventId = (store: Temp, seq: number) => {
  const found = store.uow
    .read((tx) => tx.events.listAfter(project_id, card_id, 0))
    .find((candidate) => candidate.seq === seq);
  if (found === undefined) throw new Error(`no event at seq ${seq}`);
  return found.id;
};

/** Read the newest event id without opening a nested transaction. */
const latestEventId = (store: Temp) =>
  (
    store.database
      .prepare(
        "SELECT id FROM events WHERE project_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(project_id) as { id: string } | undefined
  )?.id as never;

const note = (
  store: Temp,
  seq = 1,
  recipient: never = {
    kind: "assignment",
    assignment_id: assignment().id,
  } as never,
) => ({
  project_id,
  event_id: eventId(store, seq),
  recipient,
  card_id,
  seq,
  kind: "comment",
});

test("the same event recorded twice for one recipient yields one notification", () => {
  withTempStore((store) => {
    seed(store);
    const first = store.recordNotification(note(store));
    const second = store.recordNotification(note(store));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.notification.id).toBe(first.notification.id);
    expect(store.listNotifications({ project_id })).toHaveLength(1);
  });
});

test("the same event for a different recipient is a separate notification", () => {
  withTempStore((store) => {
    seed(store);
    store.recordNotification(note(store));
    expect(
      store.recordNotification(note(store, 1, { kind: "pm_ops" } as never))
        .created,
    ).toBe(true);
    expect(store.listNotifications({ project_id })).toHaveLength(2);
  });
});

test("pending notifications are grouped by recipient", () => {
  withTempStore((store) => {
    seed(store);
    store.recordNotification(note(store));
    store.recordNotification(note(store, 1, { kind: "pm_ops" } as never));
    const groups = store.notificationsByRecipient(project_id);
    expect([...groups.keys()].sort()).toEqual([
      `assignment:${assignment().id}`,
      "pm_ops",
    ]);
    expect(groups.get("pm_ops")).toHaveLength(1);
  });
});

test("the notification state machine is enforced by the store", () => {
  withTempStore((store) => {
    seed(store);
    const { notification } = store.recordNotification(note(store));
    const belled = store.moveNotification({
      project_id,
      id: notification.id,
      event: "bell",
      patch: { attempts: 1, bell: "[bell] fixture" },
    });
    expect(belled.status).toBe("belled");
    expect(belled.attempts).toBe(1);

    const acked = store.moveNotification({
      project_id,
      id: notification.id,
      event: "ack",
    });
    expect(acked.status).toBe("acked");
    // Terminal: ringing an acknowledged notification is refused.
    expect(() =>
      store.moveNotification({
        project_id,
        id: notification.id,
        event: "bell",
      }),
    ).toThrow(/acked/);
    expect(store.listNotifications({ project_id })[0]?.status).toBe(
      "acked" satisfies NotificationStatus,
    );
  });
});

test("a delivery failure is recorded before explicit retry preserves its identity and attempt count", () => {
  withTempStore((store) => {
    seed(store);
    const { notification } = store.recordNotification(note(store));
    const failed = store.moveNotification({
      project_id,
      id: notification.id,
      event: "deliver_failed",
      patch: { attempts: 2, bell: "[bell] fixture" },
    });
    expect(failed.status).toBe("delivery_failed");
    expect(store.listNotifications({ project_id })).toEqual([failed]);
    const retried = store.moveNotification({
      project_id,
      id: notification.id,
      event: "retry",
    });
    expect(retried).toMatchObject({
      id: notification.id,
      event_id: notification.event_id,
      recipient: notification.recipient,
      card_id: notification.card_id,
      seq: notification.seq,
      created_at: notification.created_at,
      status: "pending",
      attempts: 2,
      bell: "[bell] fixture",
    });
    expect(store.listNotifications({ project_id })).toEqual([retried]);
  });
});

test("the Assignment's ACK cursor confirms every notification it covers", () => {
  withTempStore((store) => {
    seed(store);
    store.recordNotification(note(store, 1));
    store.recordNotification(note(store, 5));
    // The Agent ACKs up to seq 3 through the M1 cursor path.
    store.uow.run((tx) =>
      tx.cursors.put(project_id, {
        assignment_id: assignment().id,
        card_id,
        acked_seq: 3,
      } as never),
    );

    expect(store.acknowledgeNotifications(project_id, assignment().id)).toBe(1);
    expect(
      store
        .listNotifications({ project_id })
        .map((candidate) => [candidate.seq, candidate.status]),
    ).toEqual([
      [1, "acked"],
      [5, "pending"],
    ]);
  });
});

test("the Router cursor only moves forward, per stream", () => {
  withTempStore((store) => {
    seed(store);
    expect(store.routerCursor(project_id, card_id)).toBe(0);
    expect(store.advanceRouterCursor(project_id, card_id, 7)).toBe(7);
    // A stale consumer cannot rewind the stream.
    expect(store.advanceRouterCursor(project_id, card_id, 3)).toBe(7);
    expect(store.advanceRouterCursor(project_id, card_id, 9)).toBe(9);
    expect(store.routerCursor(project_id, card_id)).toBe(9);
    expect(() => store.advanceRouterCursor(project_id, card_id, -1)).toThrow(
      /non-negative/,
    );
    // The project-level stream keeps its own position.
    expect(store.routerCursor(project_id, PROJECT_EVENT_STREAM)).toBe(0);
  });
});

test("two cards whose seqs overlap are both consumed, neither is skipped", () => {
  withTempStore((store) => {
    seed(store);
    const other = "C-2" as CardId;
    store.uow.run((tx) => {
      tx.cards.put(project_id, card({ id: other }));
      // Both cards have events 1..5: seq is numbered per stream.
      for (const seq of [1, 2, 3, 4, 5]) {
        tx.events.append(
          project_id,
          event({
            seq,
            card_id: other,
            // Ids are unique across the project; only seq is per stream.
            id: `01J0000000000000000000C2${seq}` as never,
          }) as never,
        );
      }
    });

    // The router consumed C-1 up to seq 5...
    store.advanceRouterCursor(project_id, card_id, 5);
    // ...which must say nothing about C-2, whose events are still pending.
    expect(store.routerCursor(project_id, other)).toBe(0);
    const pending = store.uow
      .read((tx) => tx.events.listAfter(project_id, other, 0))
      .filter(
        (candidate) => candidate.seq > store.routerCursor(project_id, other),
      );
    expect(pending.map((candidate) => candidate.seq)).toEqual([1, 2, 3, 4, 5]);

    // Advancing C-2 does not disturb C-1.
    store.advanceRouterCursor(project_id, other, 3);
    expect(store.routerCursor(project_id, other)).toBe(3);
    expect(store.routerCursor(project_id, card_id)).toBe(5);
  });
});

test("a failed transaction leaves neither notifications nor a cursor", () => {
  withTempStore((store) => {
    seed(store);
    expect(() =>
      store.uow.run(() => {
        // The router writes both facts in one transaction (M3.4).
        recordNotification(store.database, {
          project_id,
          event_id: latestEventId(store),
          recipient: { kind: "assignment", assignment_id: assignment().id },
          card_id,
          seq: 1,
          kind: "comment",
        });
        advanceRouterCursor(store.database, project_id, card_id, 5);
        throw new Error("router crashed");
      }),
    ).toThrow(/router crashed/);
    expect(store.listNotifications({ project_id })).toHaveLength(0);
    expect(store.routerCursor(project_id, card_id)).toBe(0);
  });
});

test("notifications survive a restart with their status", () => {
  withTempStore((store, dataDir) => {
    seed(store);
    const { notification } = store.recordNotification(note(store));
    store.moveNotification({ project_id, id: notification.id, event: "bell" });

    const reopened = Store.open({ dataDir });
    try {
      expect(reopened.listNotifications({ project_id })[0]?.status).toBe(
        "belled",
      );
    } finally {
      reopened.close();
    }
  });
});

test("reassignNotifications moves a replaced standing PM's unfinished inbox", () => {
  withTempStore((store) => {
    seed(store);
    const old = assignment().id;
    const addressed = store.recordNotification(note(store, 1)).notification;
    const pinned = store.recordNotification(
      note(store, 5, { kind: "pm_ops" } as never),
    ).notification;
    store.moveNotification({
      project_id,
      id: pinned.id,
      event: "bell",
      patch: { run_id: "R-9" as never, attempts: 1 },
    });
    const done = store.recordNotification(
      note(store, 5, {
        kind: "assignment",
        assignment_id: old,
      } as never),
    ).notification;
    store.moveNotification({ project_id, id: done.id, event: "ack" });

    const moved = store.uow.run(() =>
      reassignNotifications(store.database, {
        project_id,
        from: old,
        to: "A-99" as never,
        run_ids: ["R-9"],
      }),
    );
    expect(moved).toBe(2);
    const rows = new Map(
      store.listNotifications({ project_id }).map((n) => [n.id, n]),
    );
    expect(rows.get(addressed.id)?.recipient).toEqual({
      kind: "assignment",
      assignment_id: "A-99",
    });
    expect(
      store.listNotifications({ project_id, assignment_id: "A-99" as never }),
    ).toHaveLength(1);
    expect(rows.get(pinned.id)).toMatchObject({
      recipient: { kind: "pm_ops" },
      status: "pending",
      attempts: 0,
    });
    expect(rows.get(pinned.id)?.run_id).toBeUndefined();
    // Terminal rows are history and stay where they were.
    expect(rows.get(done.id)).toMatchObject({
      status: "acked",
      recipient: { kind: "assignment", assignment_id: old },
    });
  });
});

test("reassignNotifications hands failed deliveries to the new Assignment as pending", () => {
  withTempStore((store) => {
    seed(store);
    const old = assignment().id;
    const addressed = store.recordNotification(note(store, 1)).notification;
    store.moveNotification({
      project_id,
      id: addressed.id,
      event: "deliver_failed",
    });
    const pinned = store.recordNotification(
      note(store, 5, { kind: "pm_ops" } as never),
    ).notification;
    store.moveNotification({
      project_id,
      id: pinned.id,
      event: "bell",
      patch: { run_id: "R-9" as never, attempts: 1 },
    });
    store.moveNotification({
      project_id,
      id: pinned.id,
      event: "deliver_failed",
    });

    expect(
      store.uow.run(() =>
        reassignNotifications(store.database, {
          project_id,
          from: old,
          to: "A-99" as never,
          run_ids: ["R-9"],
        }),
      ),
    ).toBe(2);
    const rows = store.listNotifications({ project_id });
    expect(rows.find((n) => n.id === addressed.id)?.status).toBe("acked");
    expect(rows.find((n) => n.id === pinned.id)?.status).toBe("acked");
    const handed = store.listNotifications({
      project_id,
      assignment_id: "A-99" as never,
    });
    expect(handed.map((n) => [n.seq, n.status, n.attempts])).toEqual([
      [1, "pending", 0],
      [5, "pending", 0],
    ]);
    expect(handed.every((n) => n.run_id === undefined)).toBe(true);
  });
});
