import { expect, test } from "vitest";
import {
  deriveCardStatus,
  mergePlan,
  recordDecision,
  requestMerge,
  transition,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human, value } from "./test-fixtures.js";

test.each([
  ["card", "review", "completion_review_passed", "awaiting_merge", "todo"],
  ["card", "awaiting_merge", "merge_not_required", "done", "review"],
  ["card", "awaiting_merge", "merge_succeeded", "done", "in_progress"],
  ["card", "awaiting_merge", "merge_conflicted", "in_progress", "done"],
  ["card", "awaiting_merge", "cancel", "cancelled", "cancelled"],
  ["produce", "accepted", "merge_conflicted", "changes_requested", "delivered"],
] as const)(
  "invariants 11, 13: %s %s --%s--> %s rejects %s",
  (machine, from, event, to, invalid) => {
    expect(transition(machine, from, event)).toEqual({ ok: true, value: to });
    expect(transition(machine, invalid, event)).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
  },
);

test("invariant 13: a real dev card waits for confirmation and preserves the accepted version", async () => {
  const f = mergeFixture();
  const { product, completion } = await f.accept();
  expect(f.state.cards[0]).toMatchObject({
    status: "awaiting_merge",
    merge_policy: "confirm",
  });
  expect(f.state.cards[0]?.resolution).toBeUndefined();
  expect(
    deriveCardStatus("awaiting_merge", f.state.work_items, completion),
  ).toBe("awaiting_merge");
  expect(mergePlan(f.state, f.card.id)).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
  const q = f.state.decisions[0];
  if (!q) throw new Error("Missing confirmation");
  expect(q).toMatchObject({
    trigger: "merge_confirmation",
    kind: "approve",
    target: { delivery_id: completion.id },
    blocking: true,
    decider: "human",
    affected_work_items: [],
  });
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option: "merge",
        rationale: "Approved",
        raw_quote: "Merge",
      },
      f.io,
    ),
  );
  expect(value(mergePlan(f.state, f.card.id))).toMatchObject({
    completion_id: completion.id,
    deliveries: [
      {
        delivery_id: product.id,
        work_item_id: product.work_item_id,
        sha: product.subject.value,
      },
    ],
  });
  expect(
    mergePlan(
      {
        ...f.state,
        decisions: f.state.decisions.map((v) => ({ ...v, status: "revoked" })),
      },
      f.card.id,
    ).ok,
  ).toBe(false);
  await expect(f.deliver()).rejects.toThrow(/awaiting merge/);
});

test("invariants 11, 13: hold stays awaiting_merge and a fresh confirmation must be approved", async () => {
  const f = mergeFixture();
  await f.accept();
  const q = f.state.decisions[0];
  if (!q) throw new Error("Missing confirmation");
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option: "hold",
        rationale: "Wait",
        raw_quote: "Wait",
      },
      f.io,
    ),
  );
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  expect(
    requestMerge(f.state, f.actor(f.coder), { card_id: f.card.id }, f.io),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  const next = f.commit(
    requestMerge(f.state, human, { card_id: f.card.id }, f.io),
  );
  expect(next.id).not.toBe(q.id);
  expect(next.amends).toBe(q.id);
  expect(f.state.decisions.find((v) => v.id === q.id)?.status).toBe(
    "superseded",
  );
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  expect(requestMerge(f.state, human, { card_id: f.card.id }, f.io).ok).toBe(
    false,
  );
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: next.id,
        option: "merge",
        rationale: "Now",
        raw_quote: "Merge",
      },
      f.io,
    ),
  );
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
  expect(f.state.cards[0]?.status).toBe("awaiting_merge");
});

test("invariant 13: auto policy still requires completion review; non-Git completion finishes directly", async () => {
  const f = mergeFixture("auto");
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  await f.accept();
  expect(f.state.cards[0]?.status).toBe("awaiting_merge");
  expect(f.state.decisions).toEqual([]);
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
  const docs = mergeFixture();
  await docs.accept(false);
  expect(docs.state.cards[0]).toMatchObject({
    status: "done",
    resolution: "done",
  });
  expect(docs.state.decisions).toEqual([]);
});

test("invariants 13, 14: missing delivery, stale confirmation and unaccepted versions cannot form a merge plan", async () => {
  const f = mergeFixture("auto");
  const { product } = await f.accept();
  for (const status of ["submitted", "rejected", "superseded"] as const)
    expect(
      mergePlan(
        {
          ...f.state,
          deliveries: f.state.deliveries.map((v) =>
            v.id === product.id ? { ...v, status } : v,
          ),
        },
        f.card.id,
      ).ok,
    ).toBe(false);
  expect(mergePlan({ ...f.state, deliveries: [] }, f.card.id).ok).toBe(false);
  expect(mergePlan({ ...f.state, project_id: "other" }, f.card.id).ok).toBe(
    false,
  );
});
