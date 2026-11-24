import type { CardId, Event } from "@cardigan/domain";
import { expect, test } from "vitest";
import { eventRepository } from "./repositories.js";
import { Store } from "./store.js";
import { card, project_id as P, withTempStore } from "./test-support.js";

const cardId = card().id;
const audit = (id: string, seq: number, card_id?: CardId): Event => ({
  id: id as Event["id"],
  seq,
  ...(card_id ? { card_id } : {}),
  type: "fixture",
  actor: { kind: "system", project_id: P },
  payload: { n: seq },
  created_at: "2026-11-23T00:00:00.000Z",
});
type Reader = {
  events: {
    listAfter(
      project: typeof P,
      card: CardId | undefined,
      since: number,
    ): readonly Event[];
  };
};

test("C-640: transaction listAfter matches the SQL stream read, own writes and rollback included", () => {
  withTempStore((store, dataDir) => {
    const other = Store.open({ dataDir });
    const sql = eventRepository(store.database, "read");
    const compare = (tx: Reader) => {
      for (const stream of [undefined, cardId, "C-404" as CardId])
        for (const since of [0, 1, 2, 3, 99]) {
          const actual = tx.events.listAfter(P, stream, since);
          expect(actual).toEqual(sql.listAfter(P, stream, since));
          // A fresh array each call: callers may sort or splice it.
          if (actual.length)
            expect(tx.events.listAfter(P, stream, since)).not.toBe(actual);
        }
    };
    try {
      store.createProject({ id: P });
      store.uow.run((tx) => {
        tx.cards.put(P, card());
        // Out-of-order seq inside a stream still reads back seq ascending.
        tx.events.append(P, audit("p-1", 1));
        tx.events.append(P, audit("p-3", 3));
        tx.events.append(P, audit("p-2", 2));
        tx.events.append(P, audit("c-1", 1, cardId));
      });
      store.uow.read(compare);
      // Own uncommitted writes are visible inside the transaction only.
      expect(() =>
        store.uow.run((tx) => {
          compare(tx);
          tx.events.append(P, audit("p-4", 4));
          tx.events.append(P, audit("c-2", 2, cardId));
          compare(tx);
          expect(tx.events.listAfter(P, undefined, 3).map((e) => e.id)).toEqual(
            ["p-4"],
          );
          throw new Error("rollback");
        }),
      ).toThrow("rollback");
      store.uow.read((tx) => {
        compare(tx);
        expect(tx.events.listAfter(P, undefined, 3)).toEqual([]);
        expect(tx.events.listAfter(P, cardId, 1)).toEqual([]);
      });
      // Another connection reuses the rolled-back seq.
      other.uow.run((tx) => tx.events.append(P, audit("p-4b", 4)));
      store.uow.read((tx) => {
        compare(tx);
        expect(tx.events.listAfter(P, undefined, 3).map((e) => e.id)).toEqual([
          "p-4b",
        ]);
      });
    } finally {
      other.close();
    }
  });
});
