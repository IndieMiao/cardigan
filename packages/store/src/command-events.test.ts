import { type CardId, type Event, streamEventsBy } from "@cardigan/domain";
import { expect, test } from "vitest";
import { eventRepository } from "./repositories.js";
import { commandStateScope, Store } from "./store.js";
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

const at = "2026-01-01T00:00:00.000Z";
const event = (
  id: string,
  seq: number,
  type: string,
  card_id?: CardId,
): Event => ({
  id,
  seq,
  ...(card_id ? { card_id } : {}),
  type,
  actor: { kind: "system", P },
  payload: {},
  created_at: at,
});

test("C-639 type subsets come from the log index and never see later rows", () => {
  withTempStore((store) => {
    store.createProject({ id: P });
    const a = "C-1" as CardId;
    const b = "C-2" as CardId;
    store.uow.run((tx) => {
      tx.cards.put(P, card({ id: a }));
      tx.cards.put(P, card({ id: b }));
      tx.events.append(P, event("s1", 1, "noise"));
      tx.events.append(P, event("a1", 1, "card_merged", a));
      tx.events.append(P, event("b1", 1, "noise", b));
      tx.events.append(P, event("a2", 2, "noise", a));
      tx.events.append(P, event("b2", 2, "card_closed", b));
    });
    const first = store.uow.read((tx) => {
      const streams = tx.events.listStreams?.(P);
      if (!streams) throw new Error("missing bulk port");
      expect(streams.get(a)?.map((e) => e.id)).toEqual(["a1", "a2"]);
      const merged = streams.ofTypes(new Set(["card_merged"]));
      expect([...merged.keys()]).toEqual([a]);
      expect(merged.get(a)?.map((e) => e.id)).toEqual(["a1"]);
      expect(streams.ofTypes(new Set(["card_merged"]))).toBe(merged);
      // Several types interleave in seq order inside each stream.
      const both = streams.ofTypes(new Set(["noise", "card_closed"]));
      expect(both.get(b)?.map((e) => e.id)).toEqual(["b1", "b2"]);
      expect(both.get("")?.map((e) => e.id)).toEqual(["s1"]);
      // Iteration keeps the former eager map's first-append order.
      expect([...streams.keys()]).toEqual(["", a, b]);
      expect(streams.get("missing")).toBeUndefined();
      expect(streams.has(b)).toBe(true);
      return streams;
    });
    store.uow.run((tx) => {
      tx.events.append(P, event("a3", 3, "card_merged", a));
    });
    store.uow.read((tx) => {
      const streams = tx.events.listStreams?.(P);
      if (!streams) throw new Error("missing bulk port");
      expect(streams).not.toBe(first);
      const merged = streams.ofTypes(new Set(["card_merged"]));
      expect(merged.get(a)?.map((e) => e.id)).toEqual(["a1", "a3"]);
      // The previous snapshot never sees later rows.
      expect(
        first
          .ofTypes(new Set(["card_merged"]))
          .get(a)
          ?.map((e) => e.id),
      ).toEqual(["a1"]);
      expect(first.get(a)?.map((e) => e.id)).toEqual(["a1", "a2"]);
    });
  });
});

test("C-639 rolled-back appends never reach committed streams or subsets", () => {
  withTempStore((store) => {
    store.createProject({ id: P });
    const a = "C-1" as CardId;
    store.uow.run((tx) => {
      tx.cards.put(P, card({ id: a }));
      tx.events.append(P, event("a1", 1, "card_merged", a));
    });
    const types = new Set(["card_merged"]);
    store.uow.read((tx) => tx.events.listStreams?.(P).ofTypes(types));
    expect(() =>
      store.uow.run((tx) => {
        tx.events.append(P, event("a2", 2, "card_merged", a));
        const streams = tx.events.listStreams?.(P);
        expect(streams?.get(a)?.map((e) => e.id)).toEqual(["a1", "a2"]);
        expect(streams?.ofTypes(types).get(a)).toHaveLength(2);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    store.uow.read((tx) => {
      const streams = tx.events.listStreams?.(P);
      expect(streams?.get(a)?.map((e) => e.id)).toEqual(["a1"]);
      expect(
        streams
          ?.ofTypes(types)
          .get(a)
          ?.map((e) => e.id),
      ).toEqual(["a1"]);
    });
  });
});

test("C-639 out-of-order seqs from interleaved writers stay sorted per stream", () => {
  withTempStore((store) => {
    store.createProject({ id: P });
    const a = "C-1" as CardId;
    store.uow.run((tx) => {
      tx.cards.put(P, card({ id: a }));
      tx.events.append(P, event("a1", 1, "x", a));
    });
    store.uow.read((tx) => tx.events.listStreams?.(P).get(a));
    store.uow.run((tx) => {
      tx.events.append(P, event("a3", 3, "x", a));
      tx.events.append(P, event("a2", 2, "x", a));
    });
    expect(
      store.uow.read((tx) =>
        tx.events
          .listStreams?.(P)
          .get(a)
          ?.map((e) => e.id),
      ),
    ).toEqual(["a1", "a2", "a3"]);
  });
});

test("C-639 command state scope defaults to hot and rejects unknown values", () => {
  expect(commandStateScope(undefined)).toBe("hot");
  expect(commandStateScope("")).toBe("hot");
  expect(commandStateScope("hot")).toBe("hot");
  expect(commandStateScope("full")).toBe("full");
  expect(commandStateScope("lean")).toBe("lean");
  expect(commandStateScope("slim")).toBe("slim");
  expect(() => commandStateScope("cold")).toThrow("hot, lean, slim or full");
  withTempStore((store) => {
    expect(store.commandStateScope).toBe(
      commandStateScope(process.env.CARDIGAN_COMMAND_STATE),
    );
    store.uow.read((tx) =>
      expect(tx.command_state_scope).toBe(store.commandStateScope),
    );
  });
});

test("C-652: projectMergeEvents and streamEventsBy match the SQL reads they replace", () => {
  withTempStore((store) => {
    const event = (
      id: string,
      seq: number,
      type: string,
      card_id?: CardId,
    ): Event => ({ ...audit(id, seq, card_id), type });
    // The Store's former SQL read (`events_by_type` index, then JSON.parse).
    const sqlMerge = () =>
      store.database
        .prepare(
          "SELECT doc FROM events WHERE project_id = ? AND stream = '' AND (type = 'merge_queue_configured' OR type GLOB 'merge_batch_*') ORDER BY seq",
        )
        .all(P)
        .map((r) => JSON.parse(String(r.doc)) as Event);
    const sql = eventRepository(store.database, "read");
    const byType = (card: CardId | undefined, types: readonly string[]) =>
      sql.listAfter(P, card, 0).filter((e) => types.includes(e.type));
    const compare = (
      tx: Parameters<Parameters<Store["uow"]["read"]>[0]>[0],
    ) => {
      expect(tx.projectMergeEvents?.(P)).toEqual(sqlMerge());
      for (const card of [undefined, cardId])
        for (const types of [
          ["merge_push_queued"],
          ["merge_queue_configured", "merge_batch_formed"],
          ["absent"],
        ])
          expect(streamEventsBy(tx.events, P, card, "type", types)).toEqual(
            byType(card, types),
          );
    };
    store.createProject({ id: P });
    store.uow.run((tx) => {
      tx.cards.put(P, card());
      tx.events.append(P, event("p-1", 1, "merge_queue_configured"));
      tx.events.append(P, event("p-3", 3, "merge_batch_formed"));
      tx.events.append(P, event("p-2", 2, "merge_push_queued"));
      tx.events.append(P, event("p-4", 4, "merge_batchless"));
      tx.events.append(P, event("p-5", 5, "Merge_batch_formed"));
      // A card stream's merge-typed events are not project merge events.
      tx.events.append(P, event("c-1", 1, "merge_batch_formed", cardId));
      tx.events.append(P, event("c-2", 2, "merge_push_queued", cardId));
    });
    store.uow.read(compare);
    store.uow.run((tx) => {
      tx.events.append(P, event("p-6", 6, "merge_batch_finished"));
      tx.events.append(P, event("p-7", 7, "merge_push_queued"));
      // Own uncommitted writes are included, the same as the SQL read sees them.
      expect(
        streamEventsBy(tx.events, P, undefined, "type", ["merge_push_queued"]),
      ).toEqual(byType(undefined, ["merge_push_queued"]));
    });
    store.uow.read(compare);
    expect(
      store.uow.read((tx) => tx.projectMergeEvents?.(P).map((e) => e.id)),
    ).toEqual(["p-1", "p-3", "p-6"]);
  });
});

test("C-649 chunked warm-up gives the same streams as one full read, then reads only new rows", () => {
  withTempStore((store, dataDir) => {
    const Q = "warm-other" as typeof P;
    store.createProject({ id: P });
    store.createProject({ id: Q });
    const a = "C-1" as CardId;
    const b = "C-2" as CardId;
    store.uow.run((tx) => {
      tx.cards.put(P, card({ id: a }));
      tx.cards.put(P, card({ id: b }));
      tx.cards.put(Q, card({ id: a }));
      for (let n = 1; n <= 7; n++) {
        tx.events.append(P, event(`p${n}`, n, "x"));
        tx.events.append(Q, event(`q${n}`, n, "x", a));
        tx.events.append(P, event(`a${n}`, n, n % 2 ? "x" : "y", a));
      }
      // Out of order inside one stream: the first chunk falls back to a rebuild.
      tx.events.append(P, event("b2", 2, "x", b));
      tx.events.append(P, event("b1", 1, "x", b));
    });
    const read = (s: Store) =>
      s.uow.read((tx) => {
        const streams = tx.events.listStreams?.(P);
        if (!streams) throw new Error("missing bulk port");
        return [...streams].map(([key, events]) => [
          key,
          events.map((e) => e.id),
        ]);
      });
    const reference = Store.open({ dataDir });
    const warmed = Store.open({ dataDir });
    try {
      const expected = read(reference);
      expect(expected).toContainEqual([b, ["b1", "b2"]]);
      let calls = 1;
      while (!warmed.warmCommandEvents(P, 3)) calls++;
      expect(calls).toBeGreaterThan(3);
      expect(warmed.warmCommandEvents(P, 3)).toBe(true);
      expect(read(warmed)).toEqual(expected);
      // A partial warm-up is completed by the next full read, new rows included.
      const partial = Store.open({ dataDir });
      try {
        expect(partial.warmCommandEvents(P, 4)).toBe(false);
        store.uow.run((tx) => tx.events.append(P, event("a8", 8, "x", a)));
        const after = read(reference);
        expect(after).toContainEqual([
          a,
          [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `a${n}`),
        ]);
        expect(read(partial)).toEqual(after);
        expect(read(warmed)).toEqual(after);
      } finally {
        partial.close();
      }
    } finally {
      reference.close();
      warmed.close();
    }
  });
});

test("C-671 slim keeps closed cards' other rows dormant and reads them back unchanged", () => {
  withTempStore((store, dataDir) => {
    store.createProject({ id: P });
    const open = "C-1" as CardId;
    const closed = "C-2" as CardId;
    const reopened = "C-3" as CardId;
    store.uow.run((tx) => {
      tx.cards.put(P, card({ id: open }));
      tx.cards.put(P, card({ id: closed, status: "done" }));
      tx.cards.put(P, card({ id: reopened, status: "cancelled" }));
      for (let n = 1; n <= 6; n++) {
        tx.events.append(P, event(`p${n}`, n, "x"));
        tx.events.append(P, event(`o${n}`, n, "comment_posted", open));
        // card_merged is a whitelisted fact; the others stay dormant.
        tx.events.append(
          P,
          event(`c${n}`, n, n % 3 ? "comment_posted" : "card_merged", closed),
        );
        tx.events.append(P, event(`r${n}`, n, "run_started", reopened));
      }
    });
    const read = (s: Store) =>
      s.uow.read((tx) => {
        const streams = tx.events.listStreams?.(P);
        if (!streams) throw new Error("missing bulk port");
        return [...streams].map(([key, events]) => [key, events]);
      });
    const sql = eventRepository(store.database, "read");
    const full = Store.open({ dataDir, commandState: "full" });
    const slim = Store.open({ dataDir, commandState: "slim" });
    const warmed = Store.open({ dataDir, commandState: "slim" });
    try {
      const view = slim.uow.read((tx) => tx.events.listStreams?.(P));
      if (!view || !("base" in view)) throw new Error("missing log view");
      const log = view.base;
      // 4 comments on the closed card, 6 run rows on the cancelled one.
      expect(log.dormant).toBe(10);
      // A slim history of cold cards decodes nothing.
      const history = view.history(["", open, closed, reopened], {
        full: new Set([open]),
        omit: new Set(),
        keep: new Set(["card_merged"]),
      });
      expect(history.map((e) => e.id)).toEqual([
        ...[1, 2, 3, 4, 5, 6].map((n) => `p${n}`),
        ...[1, 2, 3, 4, 5, 6].map((n) => `o${n}`),
        "c3",
        "c6",
      ]);
      expect(log.dormant).toBe(10);
      // A cursor read at the head decodes nothing; an older one decodes.
      slim.uow.read((tx) => {
        expect(tx.events.listAfter(P, closed, 6)).toEqual([]);
        expect(log.dormant).toBe(10);
        for (const stream of [undefined, open, closed, reopened])
          for (const since of [0, 2, 5])
            expect(tx.events.listAfter(P, stream, since)).toEqual(
              sql.listAfter(P, stream, since),
            );
      });
      expect(log.dormant).toBe(0);
      expect(read(slim)).toEqual(read(full));
      // Rows written after the first read are always decoded.
      store.uow.run((tx) =>
        tx.events.append(P, event("c7", 7, "comment_posted", closed)),
      );
      expect(read(slim)).toEqual(read(full));
      // Chunked warm-up leaves the rows dormant that existed at its first
      // read, c7 included.
      while (!warmed.warmCommandEvents(P, 4));
      const warm = warmed.uow.read((tx) => tx.events.listStreams?.(P));
      if (!warm || !("base" in warm)) throw new Error("missing log view");
      expect(warm.base.dormant).toBe(11);
      expect(read(warmed)).toEqual(read(full));
    } finally {
      full.close();
      slim.close();
      warmed.close();
    }
  });
});

test("C-774: a cold projectMergeEvents reads the type index without decoding the project's history", () => {
  withTempStore((store) => {
    const event = (id: string, seq: number, type: string): Event => ({
      ...audit(id, seq),
      type,
    });
    const sqlMerge = () =>
      store.database
        .prepare(
          "SELECT doc FROM events WHERE project_id = ? AND stream = '' AND (type = 'merge_queue_configured' OR type GLOB 'merge_batch_*') ORDER BY seq",
        )
        .all(P)
        .map((r) => JSON.parse(String(r.doc)) as Event);
    store.createProject({ id: P });
    store.uow.run((tx) => {
      tx.events.append(P, event("p-1", 1, "merge_queue_configured"));
      tx.events.append(P, event("p-2", 2, "merge_push_queued"));
      tx.events.append(P, event("p-3", 3, "merge_batch_formed"));
    });
    const cold = store.uow.read((tx) => tx.projectMergeEvents?.(P));
    expect(cold?.map((e) => e.id)).toEqual(["p-1", "p-3"]);
    expect(cold).toEqual(sqlMerge());
    // The history is still undecoded: warming one row does not catch up.
    expect(store.warmCommandEvents(P, 1)).toBe(false);
    // Rows committed meanwhile are seen on the cold path too.
    store.uow.run((tx) =>
      tx.events.append(P, event("p-4", 4, "merge_batch_finished")),
    );
    expect(
      store.uow.read((tx) => tx.projectMergeEvents?.(P))?.map((e) => e.id),
    ).toEqual(["p-1", "p-3", "p-4"]);
    // Once decoded, the in-memory index answers the same rows.
    while (!store.warmCommandEvents(P, 1));
    expect(store.uow.read((tx) => tx.projectMergeEvents?.(P))).toEqual(
      sqlMerge(),
    );
  });
});
