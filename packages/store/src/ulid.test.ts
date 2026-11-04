import { parseEventId } from "@cardigan/domain";
import { expect, test } from "vitest";
import { card, project_id, withTempStore } from "./test-support.js";
import { newUlid } from "./ulid.js";

test("newUlid produces a canonical ULID the domain accepts", () => {
  const id = newUlid(1_767_225_600_000);
  expect(id).toHaveLength(26);
  expect(parseEventId(id).ok).toBe(true);
});

test("newUlid sorts by timestamp and stays unique within one millisecond", () => {
  const early = newUlid(1_000, new Uint8Array(10));
  const late = newUlid(2_000, new Uint8Array(10));
  expect(early < late).toBe(true);

  const ids = new Set(Array.from({ length: 100 }, () => newUlid()));
  expect(ids.size).toBe(100);
  for (const id of ids) {
    expect(parseEventId(id).ok).toBe(true);
  }
});

test("newUlid rejects impossible inputs", () => {
  expect(() => newUlid(-1)).toThrow(/non-negative/);
  expect(() => newUlid(1, new Uint8Array(4))).toThrow(/10 bytes/);
});

test("event ids allocated by the store are valid ULIDs", () => {
  withTempStore((store) => {
    store.uow.run((tx) => tx.cards.put(project_id, card()));
    const ids = store.uow.run((tx) => {
      const written = [
        tx.ids.nextEventId(),
        tx.ids.nextEventId(),
        tx.ids.nextEventId(),
      ];
      for (const id of written) {
        tx.events.append(project_id, {
          id,
          card_id: card().id,
          seq: tx.ids.nextEventSequence(project_id, card().id),
          type: "fictional",
          actor: { kind: "system", project_id },
          payload: null,
          created_at: "2026-01-01T00:00:00.000Z",
        });
      }
      return written;
    });

    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      expect(parseEventId(id).ok).toBe(true);
    }
  });
});
