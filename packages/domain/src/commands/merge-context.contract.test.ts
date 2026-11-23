import { expect, test } from "vitest";
import type { Card, Delivery, WorkItem } from "../entities.js";
import { acceptedCompletion } from "./merge-context.js";

const card = (id: string) => ({ id }) as Card;
const item = (id: string, card_id: string) => ({ id, card_id }) as WorkItem;
const delivery = (
  id: string,
  work_item_id: string,
  status: Delivery["status"],
  kind: Delivery["kind"] = "card_completion",
) => ({ id, work_item_id, status, kind }) as Delivery;
const rejected = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as { error?: { code?: string } }).error?.code;
  }
  return undefined;
};
/** The original nested scan, kept as the behavioural reference. */
function reference(
  state: { work_items: WorkItem[]; deliveries: Delivery[] },
  c: Card,
) {
  return [
    ...state.deliveries.filter(
      (v) =>
        v.kind === "card_completion" &&
        v.status !== "superseded" &&
        state.work_items.some(
          (w) => w.card_id === c.id && w.id === v.work_item_id,
        ),
    ),
  ].sort(
    (a, b) => Number(b.id.replace(/\D/g, "")) - Number(a.id.replace(/\D/g, "")),
  )[0];
}

test("C-629: only this card's newest live completion counts, and it must be accepted", () => {
  const state = {
    work_items: [item("W-1", "C-1"), item("W-2", "C-1"), item("W-3", "C-2")],
    deliveries: [
      delivery("D-9", "W-1", "accepted"),
      delivery("D-10", "W-2", "accepted"),
      delivery("D-11", "W-1", "superseded"),
      delivery("D-12", "W-3", "submitted"),
      delivery("D-13", "W-1", "submitted", "code"),
    ],
  };
  // Numeric id order (D-10 after D-9); superseded, other-card and product deliveries ignored.
  expect(acceptedCompletion(state, card("C-1")).id).toBe("D-10");
  expect(rejected(() => acceptedCompletion(state, card("C-2")))).toBe(
    "invariant_violation",
  );
  expect(rejected(() => acceptedCompletion(state, card("C-3")))).toBe(
    "invariant_violation",
  );
  // A newer live completion that is not yet accepted blocks the older acceptance.
  state.deliveries.push(delivery("D-14", "W-2", "submitted"));
  expect(rejected(() => acceptedCompletion(state, card("C-1")))).toBe(
    "invariant_violation",
  );
});

test("C-629: indexed lookup matches the original nested scan on a crowded project", () => {
  const statuses: Delivery["status"][] = [
    "accepted",
    "submitted",
    "superseded",
  ];
  const work_items = Array.from({ length: 400 }, (_, i) =>
    item(`W-${i}`, `C-${i % 60}`),
  );
  const deliveries = Array.from({ length: 1500 }, (_, i) =>
    delivery(
      `D-${(i * 37) % 1500}`,
      `W-${(i * 13) % 420}`,
      statuses[(i * 7) % 3] ?? "accepted",
      i % 4 === 0 ? "code" : "card_completion",
    ),
  );
  const state = { work_items, deliveries };
  let accepted = 0;
  for (let n = 0; n < 62; n++) {
    const c = card(`C-${n}`);
    const expected = reference(state, c);
    if (expected?.status === "accepted") {
      accepted++;
      expect(acceptedCompletion(state, c)).toBe(expected);
    } else
      expect(rejected(() => acceptedCompletion(state, c))).toBe(
        "invariant_violation",
      );
  }
  expect(accepted).toBeGreaterThan(0);
  expect(accepted).toBeLessThan(62);
});
