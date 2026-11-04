import { beforeEach, expect, test } from "vitest";
import type { Actor, Delivery, Review } from "../entities.js";
import {
  prepareDelivery,
  type SubmitDeliveryParams,
  type SubmitReviewParams,
  submitDelivery,
  submitReview,
  type VerifiedDelivery,
} from "../index.js";
import {
  actor,
  apply,
  fixture,
  id,
  ports,
  run,
  subject,
  value,
} from "./test-fixtures.js";

const p: SubmitDeliveryParams = {
  work_item_id: id("work_item", 1),
  kind: "code",
  summary: "Ready",
  subject,
  requested_verifiers: [id("work_item", 2)],
};
const verification = {
  verify: async () => ({
    ok: true as const,
    value: [{ kind: "commit" as const, details: "verified by host" }],
  }),
};
let io = ports();
beforeEach(() => {
  io = ports();
});
async function deliver(state = fixture(), params = p, caller: Actor = actor()) {
  const prepared = await prepareDelivery(state, caller, params, verification);
  return prepared.ok
    ? submitDelivery(state, caller, params, prepared.value, io)
    : prepared;
}
function reviewParams(delivery: Delivery): SubmitReviewParams {
  return {
    delivery_id: delivery.id,
    target_sha: delivery.subject.value,
    kind: "code",
    issues: [],
  };
}

test("invariants 8, 11, 14: delivery is verified, attributed to Actor and does not complete the card", async () => {
  const state = fixture();
  const forged = {
    ...p,
    author: "human",
    assignment_id: id("assignment", 2),
    evidence: [{ kind: "commit", details: "forged" }],
  };
  const result = value(await deliver(state, forged));
  expect(result.data.evidence).toEqual([
    { kind: "commit", details: "verified by host" },
  ]);
  expect(result.timeline[0]?.author).toBe(`assignment:${id("assignment", 1)}`);
  expect(apply(state, result).cards[0]?.status).not.toBe("done");
  expect(state.deliveries).toEqual([]);
  expect(state.work_items[0]?.status).toBe("in_progress");
});

test.each([
  [{ summary: "x".repeat(161) }, "validation_failed"],
  [{ subject: undefined }, "validation_failed"],
  [{ subject: { kind: "git_head", value: "fake" } }, "validation_failed"],
  [{ requested_verifiers: [] }, "validation_failed"],
  [{ requested_verifiers: undefined }, "validation_failed"],
  [{ requested_verifiers: [id("work_item", 3)] }, "invariant_violation"],
  [{ supersedes: id("delivery", 999) }, "stale_target"],
  [{ attachments: ["absent"] }, "not_found"],
] as const)(
  "invariant 11: invalid delivery %j is rejected",
  async (patch, code) => {
    expect(
      await deliver(fixture(), { ...p, ...patch } as SubmitDeliveryParams),
    ).toMatchObject({ ok: false, error: { code } });
  },
);

test("invariants 2, 11: another assignment, role version, project or missing tool cannot deliver", async () => {
  for (const caller of [
    actor(2, "reviewer"),
    { ...actor(), project_id: "other" },
    { ...actor(), role_version: 2 },
    { ...actor(), allowed_tools: [] },
  ]) {
    expect((await deliver(fixture(), p, caller)).ok).toBe(false);
  }
});

test("invariant 11: verifier rejection and stale/forged preflight cannot publish delivery", async () => {
  const state = fixture();
  expect(
    await prepareDelivery(state, actor(), p, {
      verify: async () => ({
        ok: false,
        error: { code: "validation_failed", message: "rejected" },
      }),
    }),
  ).toMatchObject({ ok: false });
  expect(
    await prepareDelivery(state, actor(), p, {
      verify: async () => {
        throw new Error("adapter failure");
      },
    }),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  const ticket = value(await prepareDelivery(state, actor(), p, verification));
  expect(
    submitDelivery(
      state,
      actor(),
      { ...p, subject: { ...subject, value: "b".repeat(40) } },
      ticket,
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "stale_target" } });
  expect(
    submitDelivery(state, actor(), p, {} as VerifiedDelivery, io),
  ).toMatchObject({ ok: false, error: { code: "stale_target" } });
});

test("invariants 8, 14: a reject requests rework; a new delivery supersedes old review targets", async () => {
  let state = fixture();
  const first = value(await deliver(state));
  state = apply(state, first);
  const rejected = value(
    submitReview(
      state,
      actor(2, "reviewer"),
      {
        ...reviewParams(first.data),
        issues: [
          {
            severity: "critical",
            description: "Bug",
            must_fix: true,
            pre_existing: false,
          },
        ],
      },
      io,
    ),
  );
  expect(rejected.data).toMatchObject({
    verdict: "reject",
    blocking: true,
    issues: [{ severity: "major" }],
  });
  state = apply(state, rejected);
  expect(state.work_items.find((w) => w.id === p.work_item_id)?.status).toBe(
    "changes_requested",
  );
  const next = value(
    await deliver(state, {
      ...p,
      subject: { ...subject, value: "b".repeat(40) },
    }),
  );
  state = apply(state, next);
  expect(state.deliveries.find((d) => d.id === first.data.id)?.status).toBe(
    "superseded",
  );
  expect(
    state.work_items.find((w) => w.id === id("work_item", 2))?.status,
  ).toBe("ready");
  expect(
    submitReview(state, actor(2, "reviewer"), reviewParams(first.data), io),
  ).toMatchObject({ ok: false, error: { code: "stale_target" } });
});

test("invariants 11, 14: stale SHA, foreign verifier and client verdict cannot bypass review rules", async () => {
  const first = value(await deliver());
  const state = apply(fixture(), first);
  expect(
    submitReview(
      state,
      actor(2, "reviewer"),
      { ...reviewParams(first.data), target_sha: "wrong" },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "stale_target" } });
  expect(
    submitReview(state, actor(3, "pm"), reviewParams(first.data), io),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  const forged = {
    ...reviewParams(first.data),
    verdict: "pass",
    blocking: false,
    recheck_required: true,
    issues: [
      {
        severity: "major" as const,
        description: "Bug",
        must_fix: true,
        pre_existing: false,
      },
    ],
  };
  expect(
    value(submitReview(state, actor(2, "reviewer"), forged, io)).data.verdict,
  ).toBe("reject");
  expect(
    value(
      submitReview(
        state,
        actor(2, "reviewer"),
        { ...reviewParams(first.data), recheck_required: true },
        io,
      ),
    ).data.verdict,
  ).toBe("conditional");
});

test("invariant 13: code review enables completion; only the PM completion review finishes the card", async () => {
  let state = fixture();
  const product = value(await deliver(state));
  state = apply(state, product);
  state = apply(
    state,
    value(
      submitReview(state, actor(2, "reviewer"), reviewParams(product.data), io),
    ),
  );
  expect(state.cards.find((c) => c.id === id("card", 1))?.status).not.toBe(
    "done",
  );
  const completion = value(
    await deliver(state, {
      ...p,
      kind: "card_completion",
      requested_verifiers: [id("work_item", 3)],
    }),
  );
  state = apply(state, completion);
  expect(state.deliveries.find((d) => d.id === product.data.id)?.status).toBe(
    "accepted",
  );
  expect(completion.data.evidence).toContainEqual({
    kind: "test",
    details: {
      completion_preconditions: expect.arrayContaining([
        { key: "work_item:W-1", passed: true },
        { key: "work_item:W-2", passed: true },
      ]),
    },
  });
  expect(JSON.stringify(completion.data.evidence)).not.toContain(
    "work_item:W-3",
  );
  expect(
    submitReview(
      state,
      actor(2, "reviewer"),
      reviewParams(completion.data),
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  const reviewed = value(
    submitReview(
      state,
      actor(3, "pm"),
      { ...reviewParams(completion.data), kind: "product" },
      io,
    ),
  );
  state = apply(state, reviewed);
  expect(state.cards.find((c) => c.id === id("card", 1))?.status).toBe("done");
  expect(
    state.work_items.find((w) => w.template_key === "pm_acceptance")?.status,
  ).toBe("passed");
});

test("invariants 11, 13: summary length counts code points and completion requires the template's primary producer", async () => {
  expect(
    (await deliver(fixture(), { ...p, summary: "😀".repeat(160) })).ok,
  ).toBe(true);
  const state = fixture();
  const secondary = {
    ...state,
    work_items: state.work_items.map((w) =>
      w.id === p.work_item_id ? { ...w, template_key: "secondary" } : w,
    ),
  };
  expect(
    await deliver(secondary, {
      ...p,
      kind: "card_completion",
      requested_verifiers: [id("work_item", 3)],
    }),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
});

test("invariant 13: incomplete conditions need explicit known gaps and follow-up cards; completion can be rejected", async () => {
  const product = value(await deliver());
  let state = apply(fixture(), product);
  const params = {
    ...p,
    kind: "card_completion" as const,
    requested_verifiers: [id("work_item", 3)],
  };
  expect(await deliver(state, params)).toMatchObject({
    ok: false,
    error: { code: "invariant_violation" },
  });
  const known_gaps = [1, 2].map((n) => ({
    description: "Follow up",
    followup_card_id: id("card", 2),
    precondition: `work_item:W-${n}`,
  }));
  const completion = value(await deliver(state, { ...params, known_gaps }));
  state = apply(state, completion);
  const rejected = value(
    submitReview(
      state,
      actor(3, "pm"),
      {
        ...reviewParams(completion.data),
        issues: [
          {
            severity: "major",
            description: "Not ready",
            must_fix: true,
            pre_existing: false,
          },
        ],
      },
      io,
    ),
  );
  expect(
    apply(state, rejected).cards.find((c) => c.id === id("card", 1))?.status,
  ).toBe("in_progress");
});

test("invariants 10, 11, 12: reaching the review limit pauses verification and ends its Run as blocked", async () => {
  const product = value(await deliver());
  const before = apply(fixture(), product);
  const previous: Review[] = [1, 2].map((n) => ({
    id: id("review", n),
    delivery_id: id("delivery", n),
    target_sha: subject.value,
    work_item_id: id("work_item", 2),
    run_id: id("run", n + 10),
    kind: "code",
    issues: [
      {
        severity: "major",
        description: "Bug",
        must_fix: true,
        pre_existing: false,
      },
    ],
    verdict: "reject",
    blocking: true,
    recheck_required: false,
    attachments: [],
  }));
  const state = {
    ...before,
    reviews: previous,
    runs: [run(1), run(2), run(3)],
  };
  const prior = previous[0];
  if (!prior) throw new Error("Missing prior review");
  const exhausted = {
    ...state,
    reviews: [...previous, { ...prior, id: id("review", 3) }],
    work_items: state.work_items.map((w) =>
      w.id === id("work_item", 2)
        ? { ...w, status: "in_progress" as const }
        : w,
    ),
  };
  expect(
    submitReview(
      exhausted,
      actor(2, "reviewer"),
      reviewParams(product.data),
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  expect(
    submitReview(
      state,
      actor(2, "reviewer"),
      {
        ...reviewParams(product.data),
        issues: [
          {
            severity: "minor",
            description: "New issue",
            must_fix: true,
            pre_existing: false,
          },
        ],
      },
      io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  const result = value(
    submitReview(
      state,
      actor(2, "reviewer"),
      { ...reviewParams(product.data), issues: previous[0]?.issues ?? [] },
      io,
    ),
  );
  const after = apply(state, result);
  expect(
    after.work_items.find((w) => w.id === id("work_item", 2))?.status,
  ).toBe("waiting_decision");
  expect(after.runs.find((r) => r.id === id("run", 2))).toMatchObject({
    status: "completed",
    outcome: "blocked",
    role_version: 1,
    model: "fixture-model",
    agent_cli_version: "1.0",
  });
  expect(after.runs).toHaveLength(state.runs.length);
  expect(after.decisions[0]).toMatchObject({
    status: "open",
    blocking: true,
    decider: "human",
  });
});
