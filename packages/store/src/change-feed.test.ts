import type { CardId } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  assignment,
  card,
  event,
  project_id,
  withTempStore,
} from "./test-support.js";

const FEED = ["assignments", "notifications", "bell_attempts"];
const card_id = "C-1" as CardId;

test("C-244: the change feed lists rows changed since a cursor, inbox included", () => {
  withTempStore((store) => {
    store.uow.run((tx) => {
      tx.cards.put(project_id, card());
      tx.assignments.put(project_id, assignment());
      tx.events.append(project_id, event({ seq: 1, card_id }) as never);
    });
    const read = (since?: Parameters<typeof store.changesSince>[2]) =>
      store.uow.read(() => store.changesSince(project_id, FEED, since));
    const first = read();
    // No cursor: start over.
    expect(first?.changed).toBeUndefined();
    // Nothing written: an empty change set.
    expect(read(first?.cursor)?.changed?.size).toBe(0);

    const snapshot = store.snapshotVersion(project_id);
    const eventId = store.uow.read((tx) =>
      tx.events.listAfter(project_id, card_id, 0),
    )[0]?.id;
    const { notification } = store.recordNotification({
      project_id,
      event_id: eventId as never,
      recipient: { kind: "pm_ops" },
      card_id,
      seq: 1,
      kind: "comment",
    });
    // Inbox writes never invalidate the command state snapshot.
    expect(store.snapshotVersion(project_id)).toBe(snapshot);
    const inbox = read(first?.cursor);
    expect(inbox?.changed).toEqual(
      new Map([["notifications", new Set([notification.id])]]),
    );

    store.uow.run((tx) =>
      tx.assignments.put(project_id, { ...assignment(), status: "released" }),
    );
    const both = read(first?.cursor);
    expect(both?.changed?.get("assignments")).toEqual(
      new Set([assignment().id]),
    );
    expect(both?.changed?.get("notifications")).toEqual(
      new Set([notification.id]),
    );
    // From the newer cursor only the later write remains.
    expect(read(inbox?.cursor)?.changed).toEqual(
      new Map([["assignments", new Set([assignment().id])]]),
    );

    // A rolled-back write leaves no trace in the feed.
    expect(() =>
      store.uow.run((tx) => {
        tx.assignments.put(project_id, assignment());
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(read(both?.cursor)?.changed?.size).toBe(0);
  });
});
