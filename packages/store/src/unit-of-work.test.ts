import { expect, test } from "vitest";
import {
  card,
  event,
  project_id,
  timelineEntry,
  withTempStore,
  workItem,
} from "./test-support.js";

test("UnitOfWork commits every change of one command", () => {
  withTempStore((store) => {
    store.uow.run((tx) => {
      tx.cards.put(project_id, card());
      const seq = tx.ids.nextEventSequence(project_id, card().id);
      const id = tx.ids.nextEventId();
      tx.events.append(project_id, event({ id, seq }));
      const entryId = tx.ids.nextTimelineEntryId(project_id, card().id);
      tx.timeline.put(
        project_id,
        timelineEntry({ id: entryId, short_id: entryId, event_seq: seq }),
      );
    });

    const updates = store.getUpdates({ project_id, card_id: card().id });
    expect(updates.events).toHaveLength(1);
    expect(updates.timeline).toHaveLength(1);
  });
});

test("UnitOfWork rolls back entities, events and counters when the command throws", () => {
  withTempStore((store) => {
    expect(() =>
      store.uow.run((tx) => {
        tx.cards.put(project_id, card());
        const seq = tx.ids.nextEventSequence(project_id, card().id);
        tx.events.append(project_id, event({ id: tx.ids.nextEventId(), seq }));
        void tx.ids.next(project_id, "work_item");
        throw new Error("fictional failure after the writes");
      }),
    ).toThrow(/fictional failure/);

    const updates = store.getUpdates({ project_id, card_id: card().id });
    expect(updates.events).toEqual([]);
    expect(updates.latest_seq).toBe(0);

    const counters = store.database
      .prepare("SELECT kind, value FROM id_counters WHERE project_id = ?")
      .all(project_id);
    expect(counters).toEqual([]);
    const events = store.database
      .prepare("SELECT COUNT(*) AS n FROM events WHERE project_id = ?")
      .get(project_id);
    expect(Number(events?.n)).toBe(0);
  });
});

test("a rolled-back id is not burned: the next command gets the same number", () => {
  withTempStore((store) => {
    try {
      store.uow.run((tx) => {
        expect(tx.ids.next(project_id, "card")).toBe("C-1");
        throw new Error("fictional failure");
      });
    } catch {
      // expected
    }

    const id = store.uow.run((tx) => {
      tx.cards.put(project_id, card());
      return tx.ids.next(project_id, "card");
    });
    expect(id).toBe("C-1");
  });
});

test("nested UnitOfWork is rejected instead of silently sharing a transaction", () => {
  withTempStore((store) => {
    expect(() =>
      store.uow.run(() => {
        store.uow.run(() => 1);
      }),
    ).toThrow(/nested UnitOfWork/);
  });
});

test("repositories round-trip every entity through the doc column", () => {
  withTempStore((store) => {
    store.uow.run((tx) => {
      tx.cards.put(project_id, card());
      tx.work_items.put(project_id, workItem());
    });

    expect(store.uow.run((tx) => tx.cards.get(project_id, card().id))).toEqual({
      ...card(),
      flow_version: 1,
    });
    expect(store.uow.run((tx) => tx.work_items.list(project_id))).toEqual([
      workItem(),
    ]);

    // put() is an upsert, not an insert that fails on a repeat.
    store.uow.run((tx) => tx.cards.put(project_id, card({ title: "Renamed" })));
    expect(store.uow.run((tx) => tx.cards.list(project_id))).toHaveLength(1);
    expect(
      store.uow.run((tx) => tx.cards.get(project_id, card().id))?.title,
    ).toBe("Renamed");
  });
});

test("ids are project-local and separate per kind", () => {
  withTempStore((store) => {
    store.uow.run((tx) => {
      expect(tx.ids.next(project_id, "card")).toBe("C-1");
      expect(tx.ids.next(project_id, "card")).toBe("C-2");
      expect(tx.ids.next(project_id, "work_item")).toBe("W-1");
      expect(tx.ids.next("p-other", "card")).toBe("C-1");
      expect(tx.ids.next(project_id, "decision")).toBe("Q-1");
    });
  });
});

test("timeline entry ids count per card", () => {
  withTempStore((store) => {
    store.uow.run((tx) => {
      expect(tx.ids.nextTimelineEntryId(project_id, card().id)).toBe("C-1#1");
      expect(tx.ids.nextTimelineEntryId(project_id, card().id)).toBe("C-1#2");
      expect(tx.ids.nextTimelineEntryId(project_id, "C-9" as never)).toBe(
        "C-9#1",
      );
    });
  });
});
