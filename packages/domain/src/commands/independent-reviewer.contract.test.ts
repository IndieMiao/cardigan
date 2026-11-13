import { expect, test } from "vitest";
import {
  type Actor,
  assign,
  createWorkItem,
  prepareDelivery,
  recordDecision,
  standingTools,
  submitDelivery,
  submitReview,
  updateWorkItem,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { fixture, human, ports, role, value } from "./test-fixtures.js";

function present<T>(value: T | undefined): T {
  if (value === undefined)
    throw new Error("Missing independent review fixture entity");
  return value;
}

function setup() {
  const seed = fixture();
  const ops = seed.assignments.find((a) => a.scope === "standing");
  if (!ops) throw new Error("Missing PM fixture");
  const f = mergeFixture("auto", 3, {
    state: {
      ...seed,
      cards: [],
      work_items: [],
      runs: [],
      assignments: [{ ...ops, standing_mode: "ops" }],
      roles: [...seed.roles, role("independent_reviewer")],
    },
    ports: ports(),
  });
  const pm: Actor = {
    kind: "assignment",
    project_id: f.state.project_id,
    assignment_id: ops.id,
    ...role("pm"),
    allowed_tools: standingTools(role("pm").allowed_tools, "ops"),
  };
  const params = {
    card_id: f.card.id,
    title: "Independent review",
    kind: "verify" as const,
    role_id: "independent_reviewer",
    required: true,
    completion_criteria: ["Verify security, permissions and numeric rules"],
    target_work_item_id: present(f.coder.work_item_id),
  };
  return { f, pm, params };
}

test.each([undefined, 1, 2])(
  "P2a-14: independent review creation persists a bounded limit (%s)",
  (max) => {
    const { f, pm, params } = setup();
    const item = f.commit(
      createWorkItem(
        f.state,
        pm,
        { ...params, ...(max === undefined ? {} : { max_review_rounds: max }) },
        f.io,
      ),
    );
    expect(item).toMatchObject({ kind: "verify", max_review_rounds: max ?? 2 });
    expect(f.state.work_items.find((w) => w.id === item.id)).toEqual(item);
  },
);

test.each([0, -1, 1.5, 3, Number.NaN, Number.POSITIVE_INFINITY])(
  "invariant 11: neither PM nor human can create an invalid independent review limit (%s)",
  (max) => {
    const { f, pm, params } = setup();
    for (const caller of [pm, human])
      expect(
        createWorkItem(
          f.state,
          caller,
          { ...params, max_review_rounds: max },
          f.io,
        ),
      ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  },
);

test("existing reviewers retain the global default and PM Ops limit controls", () => {
  const { f, pm, params } = setup();
  for (const max of [undefined, 4]) {
    const item = f.commit(
      createWorkItem(
        f.state,
        pm,
        {
          ...params,
          role_id: "reviewer",
          ...(max === undefined ? {} : { max_review_rounds: max }),
        },
        f.io,
      ),
    );
    expect(item).toMatchObject({ max_review_rounds: max ?? 3 });
  }
});

test.each(["reject", "conditional", "pass"] as const)(
  "invariant 11: independent review's second %s uses the existing limit state machine",
  async (verdict) => {
    const { f, pm, params } = setup();
    const item = f.commit(createWorkItem(f.state, pm, params, f.io));
    const owner = f.commit(
      assign(
        f.state,
        pm,
        { work_item_id: item.id, role_id: item.role_id },
        f.io,
      ),
    );
    // PM cannot pre-empt the two-round human escalation by widening the budget.
    const widen = (caller: Actor) =>
      updateWorkItem(
        f.state,
        caller,
        { work_item_id: item.id, max_review_rounds: 3 },
        f.io,
      );
    expect(widen(pm)).toMatchObject({
      ok: false,
      error: { code: "forbidden_tool" },
    });
    const deliver = async (sha: string) => {
      f.start(f.coder);
      const p = {
        work_item_id: params.target_work_item_id,
        kind: "code" as const,
        summary: "Ready for review",
        subject: { kind: "git_head" as const, value: sha },
        requested_verifiers: [present(f.reviewer.work_item_id), item.id],
      };
      const proof = value(
        await prepareDelivery(f.state, f.actor(f.coder), p, {
          verify: async () => ({ ok: true, value: [] }),
        }),
      );
      return f.commit(
        submitDelivery(f.state, f.actor(f.coder), p, proof, f.io),
      );
    };
    for (const sha of ["a".repeat(40), "b".repeat(40)]) {
      const target = await deliver(sha);
      f.start(owner);
      const review = f.commit(
        submitReview(
          f.state,
          f.actor(owner),
          {
            delivery_id: target.id,
            target_sha: sha,
            kind: "code",
            issues:
              verdict === "reject"
                ? [
                    {
                      severity: "critical",
                      description: "Permission check bypass",
                      proof: "Unauthorized requests reach the write path",
                      must_fix: true,
                      pre_existing: false,
                    },
                  ]
                : [],
            recheck_required: verdict === "conditional",
          },
          f.io,
        ),
      );
      expect(review.verdict).toBe(verdict);
      if (sha.startsWith("a")) expect(f.state.decisions).toEqual([]);
    }
    expect(
      f.state.reviews.filter((r) => r.work_item_id === item.id),
    ).toHaveLength(2);
    if (verdict === "pass") {
      expect(f.state.work_items.find((w) => w.id === item.id)?.status).toBe(
        "passed",
      );
      expect(f.state.decisions).toEqual([]);
      return;
    }
    expect(f.state.work_items.find((w) => w.id === item.id)?.status).toBe(
      "waiting_decision",
    );
    const decision = f.state.decisions.at(-1);
    if (!decision) throw new Error("Missing review limit decision");
    expect(decision).toMatchObject({
      trigger: "review_limit",
      status: "open",
      blocking: true,
      decider: "human",
      human_required_reason: expect.any(String),
      affected_work_items: [item.id],
    });
    const reviewEvent = f.state.events
      .filter((e) => e.type === "review_submitted")
      .at(-1);
    expect(reviewEvent?.payload).toMatchObject({
      verdict,
      rework_allowed: false,
    });
    expect(f.state.events.at(-1)?.type).toBe("decision_requested");
    expect(present(f.state.events.at(-1)).seq).toBeGreaterThan(
      present(reviewEvent).seq,
    );
    expect(
      f.state.runs.filter((r) => r.assignment_id === owner.id).at(-1),
    ).toMatchObject({
      status: "completed",
      outcome: "blocked",
    });
    // A new delivery or Run must not reopen the exhausted review budget.
    const third = await deliver("c".repeat(40));
    expect(f.state.decisions).toHaveLength(1);
    f.start(owner);
    expect(
      submitReview(
        f.state,
        f.actor(owner),
        {
          delivery_id: third.id,
          target_sha: third.subject.value,
          kind: "code",
          issues: [],
        },
        f.io,
      ),
    ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
    expect(f.state.work_items.find((w) => w.id === item.id)?.status).toBe(
      "waiting_decision",
    );
    expect(widen(pm).ok).toBe(false);
    expect(
      updateWorkItem(
        f.state,
        pm,
        {
          work_item_id: item.id,
          review_limit_decision: {
            decision_id: decision.id,
            option: "raise_limit",
            rationale: "Continue",
          },
        },
        f.io,
      ).ok,
    ).toBe(false);
    f.commit(
      recordDecision(
        f.state,
        human,
        {
          decision_id: decision.id,
          option: "raise_limit",
          rationale: "Authorize another review",
          raw_quote: "Authorize another review",
        },
        f.io,
      ),
    );
    expect(f.state.work_items.find((w) => w.id === item.id)).toMatchObject({
      status: "ready",
      max_review_rounds: 3,
    });
  },
);
