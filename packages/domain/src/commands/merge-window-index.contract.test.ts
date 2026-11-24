import { expect, test } from "vitest";
import type { Delivery, WorkItem } from "../entities.js";
import type { CardId } from "../ids.js";
import { mergeWindowVersions } from "./merge-window.js";

// C-670: frozen linear oracle (pre-index implementation).
function oracle(
  state: { deliveries: readonly Delivery[]; work_items: readonly WorkItem[] },
  card: CardId,
) {
  return state.deliveries
    .filter(
      (v) =>
        v.kind !== "card_completion" &&
        v.subject.kind === "git_head" &&
        v.status !== "superseded" &&
        state.work_items.some(
          (w) => w.id === v.work_item_id && w.card_id === card,
        ),
    )
    .map((v) => v.id)
    .sort();
}

function random(seed: number) {
  let x = seed;
  return (n: number) => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x % n;
  };
}

function snapshot(seed: number) {
  const pick = random(seed);
  const cards = ["C-1", "C-2", "C-3", "C-4"] as CardId[];
  // Duplicate work item IDs across cards are deliberate edge cases.
  const work_items = Array.from(
    { length: 12 },
    (_, i) =>
      ({
        id: `W-${pick(8)}`,
        card_id: cards[pick(cards.length)],
        kind: i % 3 ? "produce" : "verify",
      }) as unknown as WorkItem,
  );
  const deliveries = Array.from(
    { length: 40 },
    () =>
      ({
        id: `V-${pick(30)}`,
        work_item_id: `W-${pick(10)}`,
        kind: ["code", "card_completion", "doc"][pick(3)],
        status: ["submitted", "superseded", "accepted"][pick(3)],
        subject: {
          kind: ["git_head", "artifact_sha256"][pick(2)],
          value: "a".repeat(40),
        },
      }) as unknown as Delivery,
  );
  return { cards: [...cards, "C-9" as CardId], deliveries, work_items };
}

test("indexed merge window versions match the linear oracle", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const s = snapshot(seed);
    for (const card of s.cards)
      expect(mergeWindowVersions(s, card)).toEqual(oracle(s, card));
  }
});

test("a changed deliveries or work item snapshot is re-indexed; results are copies", () => {
  const s = snapshot(7);
  const card = s.work_items[0]!.card_id;
  const first = mergeWindowVersions(s, card);
  first.push("V-mutated");
  expect(mergeWindowVersions(s, card)).toEqual(oracle(s, card));
  const added = {
    ...s,
    deliveries: [
      ...s.deliveries,
      {
        id: "V-new",
        work_item_id: s.work_items[0]!.id,
        kind: "code",
        status: "submitted",
        subject: { kind: "git_head", value: "b".repeat(40) },
      } as unknown as Delivery,
    ],
  };
  expect(mergeWindowVersions(added, card)).toContain("V-new");
  expect(mergeWindowVersions(added, card)).toEqual(oracle(added, card));
  const moved = {
    ...added,
    work_items: added.work_items.map((w) =>
      w.id === s.work_items[0]!.id ? { ...w, card_id: "C-9" as CardId } : w,
    ),
  };
  expect(mergeWindowVersions(moved, "C-9" as CardId)).toEqual(
    oracle(moved, "C-9" as CardId),
  );
  expect(mergeWindowVersions(moved, card)).toEqual(oracle(moved, card));
});
