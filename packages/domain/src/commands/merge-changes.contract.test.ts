import { expect, test } from "vitest";
import {
  isReviewStale,
  mergePlan,
  recordDecision,
  recordMergeResult,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human, value } from "./test-fixtures.js";

test("invariants 13, 14: returning a merge requires fresh delivery, review, completion and confirmation", async () => {
  const f = mergeFixture();
  const { product, completion } = await f.accept();
  const decision = f.state.decisions[0];
  if (!decision) throw new Error("Missing confirmation");
  expect(decision.options).toContainEqual(
    expect.objectContaining({
      key: "request_changes",
      description: "退回修改",
    }),
  );
  const params = {
    decision_id: decision.id,
    option: "request_changes",
    rationale: "Handle empty input before merging",
    raw_quote: "Please return this for input validation",
  };
  const effect = value(recordDecision(f.state, human, params, f.io));
  f.commit({ ok: true, value: effect });
  expect(f.state.cards[0]).toMatchObject({ status: "in_progress" });
  expect(f.state.cards[0]?.resolution).toBeUndefined();
  expect(
    f.state.work_items.find((w) => w.id === product.work_item_id),
  ).toMatchObject({
    status: "changes_requested",
    assignment_id: f.coder.id,
  });
  expect(f.state.deliveries.find((d) => d.id === completion.id)?.status).toBe(
    "superseded",
  );
  expect(
    f.state.work_items.find((w) => w.id === f.pm.work_item_id)?.status,
  ).toBe("todo");
  expect(effect.events.map((e) => e.type)).toEqual([
    "decision_resolved",
    "merge_changes_requested",
  ]);
  expect(effect.events[1]?.payload).toMatchObject({
    decision_id: decision.id,
    completion_id: completion.id,
    work_item_id: product.work_item_id,
    run_kind: "fix",
    reason: params.rationale,
  });
  expect(effect.timeline).toContainEqual(
    expect.objectContaining({
      work_item_id: product.work_item_id,
      body: `退回修改：${params.rationale}`,
    }),
  );
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  expect(recordDecision(f.state, human, params, f.io).ok).toBe(false);
  await expect(f.deliver("card_completion")).rejects.toThrow();

  const next = await f.deliver("code", "b".repeat(40));
  const old = f.state.reviews.find((r) => r.delivery_id === product.id);
  if (!old) throw new Error("Missing review");
  expect(isReviewStale(old, next)).toBe(true);
  expect(
    f.state.work_items.find((w) => w.id === f.reviewer.work_item_id)?.status,
  ).toBe("ready");
  f.review(next);
  const request = await f.deliver("card_completion", next.subject.value);
  f.review(request);
  expect(f.state.cards[0]?.status).toBe("awaiting_merge");
  const confirmation = f.state.decisions.at(-1);
  if (!confirmation) throw new Error("Missing new confirmation");
  expect(confirmation.id).not.toBe(decision.id);
  expect(confirmation).toMatchObject({
    status: "open",
    target: { delivery_id: request.id },
  });
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  f.commit(
    recordDecision(
      f.state,
      human,
      { ...params, decision_id: confirmation.id, option: "merge" },
      f.io,
    ),
  );
  expect(value(mergePlan(f.state, f.card.id)).deliveries[0]?.delivery_id).toBe(
    next.id,
  );
  f.commit(
    recordMergeResult(
      f.state,
      { kind: "system", project_id: f.state.project_id },
      {
        card_id: f.card.id,
        completion_id: request.id,
        result: {
          kind: "merged",
          merge_sha: "c".repeat(40),
          previous_sha: "a".repeat(40),
        },
      },
      f.io,
    ),
  );
  expect(f.state.cards[0]).toMatchObject({
    status: "done",
    resolution: "done",
  });
});

test("invariant 11: returning a merge rejects empty reasons and unauthorized producers without changes", async () => {
  const f = mergeFixture();
  await f.accept();
  const decision = f.state.decisions[0];
  if (!decision) throw new Error("Missing confirmation");
  const before = JSON.stringify(f.state);
  const params = {
    decision_id: decision.id,
    option: "request_changes",
    rationale: "Fix validation",
    raw_quote: "Fix validation",
  };
  for (const field of ["rationale", "raw_quote"] as const)
    for (const blank of ["", " \n "])
      expect(
        recordDecision(f.state, human, { ...params, [field]: blank }, f.io),
      ).toMatchObject({
        ok: false,
        error: { code: "validation_failed" },
      });
  expect(recordDecision(f.state, f.actor(f.coder), params, f.io).ok).toBe(
    false,
  );
  expect(JSON.stringify(f.state)).toBe(before);
});

test("invariant 14: a stale confirmation cannot return another completion or a closed card", async () => {
  const f = mergeFixture();
  const { product } = await f.accept();
  const q = f.state.decisions[0];
  if (q?.kind !== "approve") throw new Error("Missing confirmation");
  const params = {
    decision_id: q.id,
    option: "request_changes",
    rationale: "Fix",
    raw_quote: "Fix",
  };
  expect(
    recordDecision(
      {
        ...f.state,
        decisions: [{ ...q, target: { delivery_id: product.id } }],
      },
      human,
      params,
      f.io,
    ),
  ).toMatchObject({
    ok: false,
    error: { code: "stale_target" },
  });
  expect(
    recordDecision(
      {
        ...f.state,
        cards: f.state.cards.map((c) => ({ ...c, status: "cancelled" })),
      },
      human,
      params,
      f.io,
    ).ok,
  ).toBe(false);
});
