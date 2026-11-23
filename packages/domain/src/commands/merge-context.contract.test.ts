import { describe, expect, it } from "vitest";
import type { Card, Delivery, WorkItem } from "../entities.js";
import { attempt } from "./core.js";
import { acceptedCompletion, newestById } from "./merge-context.js";

// The pre-C-631 implementation, kept verbatim as the oracle.
const oldNewest = <T extends { readonly id: string }>(values: readonly T[]) =>
  [...values].sort(
    (a, b) => Number(b.id.replace(/\D/g, "")) - Number(a.id.replace(/\D/g, "")),
  )[0];
function oldAcceptedCompletion(
  state: { work_items: readonly WorkItem[]; deliveries: readonly Delivery[] },
  card: Card,
) {
  const value = oldNewest(
    state.deliveries.filter(
      (v) =>
        v.kind === "card_completion" &&
        v.status !== "superseded" &&
        state.work_items.some(
          (w) => w.card_id === card.id && w.id === v.work_item_id,
        ),
    ),
  );
  if (value?.status !== "accepted") throw new Error("no accepted completion");
  return value;
}

const card = (id: string) => ({ id }) as unknown as Card;
const item = (id: string, card_id: string) =>
  ({ id, card_id }) as unknown as WorkItem;
const delivery = (
  id: string,
  work_item_id: string,
  kind: Delivery["kind"],
  status: Delivery["status"],
) => ({ id, work_item_id, kind, status }) as unknown as Delivery;

/** Deterministic LCG so failures reproduce. */
function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s % n;
  };
}

const STATUSES = [
  "accepted",
  "superseded",
  "submitted",
  "rejected",
] as const satisfies readonly Delivery["status"][];
const KINDS = [
  "card_completion",
  "card_completion",
  "code",
] as const satisfies readonly Delivery["kind"][];

function fixture(
  seed: number,
  cards: number,
  items: number,
  deliveries: number,
) {
  const r = rng(seed);
  const work_items = Array.from({ length: items }, (_, i) =>
    item(`W-${i + 1}`, `C-${r(cards) + 1}`),
  );
  const ds = Array.from({ length: deliveries }, (_, i) =>
    delivery(
      `D-${i + 1}`,
      // Some deliveries point at unknown work items.
      `W-${r(items + 5) + 1}`,
      KINDS[r(KINDS.length)] ?? "code",
      STATUSES[r(STATUSES.length)] ?? "accepted",
    ),
  );
  // Shuffle so id order is not storage order.
  for (let i = ds.length - 1; i > 0; i--) {
    const j = r(i + 1);
    [ds[i], ds[j]] = [ds[j] as Delivery, ds[i] as Delivery];
  }
  return { work_items, deliveries: ds };
}

const outcome = (f: () => Delivery) => {
  const res = attempt(f);
  return res.ok ? res.value.id : "error";
};
const oldOutcome = (f: () => Delivery) => {
  try {
    return f().id;
  } catch {
    return "error";
  }
};

describe("C-631 acceptedCompletion is linear and unchanged", () => {
  it("newestById matches a stable descending sort, including ties and non-numeric ids", () => {
    const values = [
      { id: "D-3", tag: "a" },
      { id: "X", tag: "b" },
      { id: "D-12", tag: "c" },
      { id: "Q-12", tag: "d" },
      { id: "D-2", tag: "e" },
    ];
    expect(newestById(values)).toBe(oldNewest(values));
    expect(newestById(values)?.tag).toBe("c");
    expect(newestById([])).toBeUndefined();
    expect(newestById([{ id: "X" }])).toEqual({ id: "X" });
  });

  it("ignores superseded completions and picks the newest of several", () => {
    const state = {
      work_items: [item("W-1", "C-1"), item("W-2", "C-1"), item("W-3", "C-2")],
      deliveries: [
        delivery("D-5", "W-1", "card_completion", "accepted"),
        delivery("D-9", "W-2", "card_completion", "superseded"),
        delivery("D-7", "W-2", "card_completion", "accepted"),
        delivery("D-8", "W-1", "code", "accepted"),
        // Another card's newer completion must not leak in.
        delivery("D-20", "W-3", "card_completion", "accepted"),
      ],
    };
    expect(acceptedCompletion(state, card("C-1")).id).toBe("D-7");
    expect(acceptedCompletion(state, card("C-2")).id).toBe("D-20");
  });

  it("fails when the newest live completion is not accepted", () => {
    const state = {
      work_items: [item("W-1", "C-1")],
      deliveries: [
        delivery("D-1", "W-1", "card_completion", "accepted"),
        delivery("D-2", "W-1", "card_completion", "submitted"),
      ],
    };
    const res = attempt(() => acceptedCompletion(state, card("C-1")));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("invariant_violation");
  });

  it("agrees with the old implementation on randomized states", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const state = fixture(seed, 6, 15, 40);
      for (let c = 1; c <= 7; c++) {
        const k = card(`C-${c}`);
        expect(outcome(() => acceptedCompletion(state, k))).toBe(
          oldOutcome(() => oldAcceptedCompletion(state, k)),
        );
      }
    }
  });

  it("agrees on the 2400 deliveries / 2000 work items / 20 cards benchmark fixture", () => {
    const state = fixture(631, 600, 2000, 2400);
    const cards = Array.from({ length: 20 }, (_, i) => card(`C-${i * 30 + 1}`));
    for (const k of cards)
      expect(outcome(() => acceptedCompletion(state, k))).toBe(
        oldOutcome(() => oldAcceptedCompletion(state, k)),
      );
  });
});
