import { expect, test } from "vitest";
import {
  type Assignment,
  type Delivery,
  hasRunTarget,
  states,
  type WorkItem,
} from "../index.js";
import { assignment, fixture, id, subject } from "./test-fixtures.js";

/** The pre-C-221 linear scan, kept verbatim as the reference semantics. */
function referenceHasRunTarget(
  a: Assignment,
  state: {
    readonly work_items: readonly WorkItem[];
    readonly deliveries: readonly Delivery[];
  },
): boolean {
  if (a.scope !== "work_item") return true;
  const item = state.work_items.find((w) => w.id === a.work_item_id);
  if (!item) return false;
  if (item.kind !== "verify") return true;
  return state.deliveries.some(
    (delivery) =>
      delivery.status !== "superseded" &&
      state.work_items.some(
        (w) => w.id === delivery.work_item_id && w.card_id === item.card_id,
      ) &&
      (item.target_work_item_id
        ? delivery.work_item_id === item.target_work_item_id &&
          delivery.kind !== "card_completion"
        : delivery.kind === "card_completion" &&
          delivery.requested_verifiers.includes(item.id)),
  );
}

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s % n;
  };
}

const kinds: Delivery["kind"][] = [
  "code",
  "doc",
  "test_report",
  "card_completion",
];

function delivery(n: number, patch: Partial<Delivery>): Delivery {
  return {
    id: id("delivery", n),
    work_item_id: id("work_item", 1),
    run_id: id("run", 1),
    kind: "code",
    summary: "Ready",
    subject,
    evidence: [],
    attachments: [],
    known_gaps: [],
    requested_verifiers: [],
    status: "submitted",
    ...patch,
  };
}

function randomState(seed: number) {
  const pick = rng(seed);
  const template = {
    title: "Item",
    role_id: "reviewer",
    required: true,
    depends_on: [],
    completion_criteria: ["passes"],
  };
  const itemCount = 2 + pick(10);
  const work_items: WorkItem[] = [];
  for (let i = 1; i <= itemCount; i++) {
    // Duplicate ids on another card exercise the first-match lookup.
    const n = pick(5) === 0 ? 1 + pick(i) : i;
    const card_id = id("card", 1 + pick(3));
    const shape = pick(3);
    work_items.push(
      shape === 0
        ? {
            ...template,
            id: id("work_item", n),
            card_id,
            kind: "produce",
            status: "in_progress",
          }
        : {
            ...template,
            id: id("work_item", n),
            card_id,
            kind: "verify",
            status: "ready",
            max_review_rounds: 3,
            ...(shape === 1
              ? {
                  target_work_item_id: id("work_item", 1 + pick(itemCount + 2)),
                }
              : {}),
          },
    );
  }
  const deliveries: Delivery[] = [];
  for (let d = 1, count = pick(12); d <= count; d++)
    deliveries.push(
      delivery(d, {
        work_item_id: id("work_item", 1 + pick(itemCount + 2)),
        kind: kinds[pick(kinds.length)] ?? "code",
        status: states.delivery[pick(states.delivery.length)] ?? "submitted",
        requested_verifiers: Array.from({ length: pick(4) }, () =>
          id("work_item", 1 + pick(itemCount + 2)),
        ),
      }),
    );
  const assignments: Assignment[] = Array.from(
    { length: itemCount + 2 },
    (_, i) => assignment(i + 1, "reviewer"),
  );
  const { work_item_id: _unused, ...standing } = assignment(99, "pm");
  assignments.push({ ...standing, scope: "standing" });
  return { work_items, deliveries, assignments };
}

test("invariant 14 / C-221: keyed run-target lookup matches the linear scan on every assignment", () => {
  let targets = 0;
  for (let seed = 1; seed <= 600; seed++) {
    const state = randomState(seed);
    for (const a of state.assignments) {
      const expected = referenceHasRunTarget(a, state);
      if (expected && a.scope === "work_item") targets++;
      expect(hasRunTarget(a, state), `seed ${seed} ${a.id}`).toBe(expected);
      // A second call hits the cached index and must agree.
      expect(hasRunTarget(a, state)).toBe(expected);
    }
  }
  expect(targets).toBeGreaterThan(100);
});

test("invariant 14 / C-221: a new snapshot is re-indexed and a rolled-back snapshot keeps its own answer", () => {
  const base = fixture();
  const reviewer = base.assignments[1];
  const pm = base.assignments[2];
  if (!reviewer || !pm) throw new Error("Missing fixture");
  const empty = { work_items: base.work_items, deliveries: base.deliveries };
  expect(hasRunTarget(reviewer, empty)).toBe(false);

  const code = delivery(1, { work_item_id: id("work_item", 1) });
  const submitted = { ...empty, deliveries: [code] };
  expect(hasRunTarget(reviewer, submitted)).toBe(true);
  expect(hasRunTarget(pm, submitted)).toBe(false);

  const superseded = {
    ...empty,
    deliveries: [{ ...code, status: "superseded" as const }],
  };
  expect(hasRunTarget(reviewer, superseded)).toBe(false);

  const completion = {
    ...empty,
    deliveries: [
      code,
      delivery(2, {
        kind: "card_completion",
        requested_verifiers: [id("work_item", 3)],
      }),
    ],
  };
  expect(hasRunTarget(pm, completion)).toBe(true);

  // The verify item moves to another card: same deliveries array, new work
  // items array, so the target on the old card no longer counts.
  const moved = {
    ...completion,
    work_items: completion.work_items.map((w) =>
      w.id === id("work_item", 1) ? { ...w, card_id: id("card", 2) } : w,
    ),
  };
  expect(hasRunTarget(reviewer, moved)).toBe(false);
  expect(hasRunTarget(pm, moved)).toBe(false);

  // Rollback hands the earlier arrays back; their answers are unchanged.
  expect(hasRunTarget(reviewer, empty)).toBe(false);
  expect(hasRunTarget(reviewer, submitted)).toBe(true);
  expect(hasRunTarget(reviewer, superseded)).toBe(false);
  expect(hasRunTarget(pm, completion)).toBe(true);
});
