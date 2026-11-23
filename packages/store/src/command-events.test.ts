import type { CardId, Event } from "@cardigan/domain";
import { expect, test, vi } from "vitest";
import { card, project_id, withTempStore } from "./test-support.js";

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
  actor: { kind: "system", project_id },
  payload: {},
  created_at: at,
});

test("C-639 streams decode lazily per stream and keep type subsets incremental", () => {
  withTempStore((store) => {
    store.createProject({ id: project_id });
    const a = "C-1" as CardId;
    const b = "C-2" as CardId;
    store.uow.run((tx) => {
      tx.cards.put(project_id, card({ id: a }));
      tx.cards.put(project_id, card({ id: b }));
      tx.events.append(project_id, event("s1", 1, "noise"));
      tx.events.append(project_id, event("a1", 1, "card_merged", a));
      tx.events.append(project_id, event("b1", 1, "noise", b));
      tx.events.append(project_id, event("a2", 2, "noise", a));
    });
    const parse = vi.spyOn(JSON, "parse");
    const first = store.uow.read((tx) => {
      const streams = tx.events.listStreams?.(project_id);
      if (!streams) throw new Error("missing bulk port");
      expect(parse).not.toHaveBeenCalled();
      expect(streams.get(a)?.map((e) => e.id)).toEqual(["a1", "a2"]);
      expect(parse).toHaveBeenCalledTimes(2);
      const merged = streams.ofTypes(new Set(["card_merged"]));
      expect([...merged.keys()]).toEqual([a]);
      expect(merged.get(a)?.map((e) => e.id)).toEqual(["a1"]);
      // Iteration keeps the former eager map's first-append order.
      expect([...streams.keys()]).toEqual(["", a, b]);
      expect(streams.get("missing")).toBeUndefined();
      expect(streams.has(b)).toBe(true);
      return streams;
    });
    parse.mockClear();
    // A later append decodes only rows of loaded streams or tracked types.
    store.uow.run((tx) => {
      tx.events.append(project_id, event("b2", 2, "noise", b));
      tx.events.append(project_id, event("a3", 3, "card_merged", a));
    });
    store.uow.read((tx) => {
      const streams = tx.events.listStreams?.(project_id);
      if (!streams) throw new Error("missing bulk port");
      expect(streams).not.toBe(first);
      const merged = streams.ofTypes(new Set(["card_merged"]));
      expect(merged.get(a)?.map((e) => e.id)).toEqual(["a1", "a3"]);
      expect(streams.get(a)?.map((e) => e.id)).toEqual(["a1", "a2", "a3"]);
      // The previous snapshot never sees later rows.
      expect(first.get(a)?.map((e) => e.id)).toEqual(["a1", "a2"]);
    });
    // b was loaded by the first snapshot's iteration and stays current.
    expect(
      store.uow.read((tx) =>
        tx.events
          .listStreams?.(project_id)
          .get(b)
          ?.map((e) => e.id),
      ),
    ).toEqual(["b1", "b2"]);
  });
});

test("C-639 rolled-back appends never reach committed streams or subsets", () => {
  withTempStore((store) => {
    store.createProject({ id: project_id });
    const a = "C-1" as CardId;
    store.uow.run((tx) => {
      tx.cards.put(project_id, card({ id: a }));
      tx.events.append(project_id, event("a1", 1, "card_merged", a));
    });
    const types = new Set(["card_merged"]);
    store.uow.read((tx) => tx.events.listStreams?.(project_id).ofTypes(types));
    expect(() =>
      store.uow.run((tx) => {
        tx.events.append(project_id, event("a2", 2, "card_merged", a));
        const streams = tx.events.listStreams?.(project_id);
        expect(streams?.get(a)?.map((e) => e.id)).toEqual(["a1", "a2"]);
        expect(streams?.ofTypes(types).get(a)).toHaveLength(2);
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    store.uow.read((tx) => {
      const streams = tx.events.listStreams?.(project_id);
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
    store.createProject({ id: project_id });
    const a = "C-1" as CardId;
    store.uow.run((tx) => {
      tx.cards.put(project_id, card({ id: a }));
      tx.events.append(project_id, event("a1", 1, "x", a));
    });
    store.uow.read((tx) => tx.events.listStreams?.(project_id).get(a));
    store.uow.run((tx) => {
      tx.events.append(project_id, event("a3", 3, "x", a));
      tx.events.append(project_id, event("a2", 2, "x", a));
    });
    expect(
      store.uow.read((tx) =>
        tx.events
          .listStreams?.(project_id)
          .get(a)
          ?.map((e) => e.id),
      ),
    ).toEqual(["a1", "a2", "a3"]);
  });
});
