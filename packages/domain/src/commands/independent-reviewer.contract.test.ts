import { expect, test } from "vitest";
import {
  type Actor,
  assign,
  createCard,
  createWorkItem,
  developmentCardTemplate,
  manageCardTemplate,
  prepareDelivery,
  recordDecision,
  standingTools,
  submitDelivery,
  submitReview,
  updateWorkItem,
  type WorkItem,
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

test.each(
  (["direct", "template"] as const).flatMap((source) =>
    (["reject", "conditional", "pass"] as const).map((verdict) => ({
      source,
      verdict,
    })),
  ),
)(
  "invariant 11: $source independent review's second $verdict uses the existing limit state machine",
  async ({ source, verdict }) => {
    const { f, pm, params } = setup();
    let producer = f.coder;
    let item: WorkItem;
    if (source === "direct") {
      item = f.commit(createWorkItem(f.state, pm, params, f.io));
    } else {
      // Register a real custom template, then let PM Ops create its card.
      // Do not use mergeFixture's initial budget override for this card.
      const template = f.commit(
        manageCardTemplate(
          f.state,
          human,
          {
            action: "add",
            definition: {
              ...developmentCardTemplate,
              id: "independent-review",
              work_items: developmentCardTemplate.work_items.map((w) =>
                w.key === "code_review"
                  ? { ...w, role_id: "independent_reviewer" }
                  : w,
              ),
            },
          },
          f.io,
        ),
      );
      const card = f.commit(
        createCard(
          f.state,
          pm,
          {
            template_id: template.id,
            title: "Template independent review",
            goal: "Enforce the same review limit for template work items",
            acceptance_criteria: [
              "Two non-pass reviews require a human decision",
            ],
            source: {
              kind: "quote",
              text: "Review this change independently",
            },
            repo: "fixture",
            base_branch: "main",
          },
          f.io,
        ),
      );
      const items = f.state.work_items.filter((w) => w.card_id === card.id);
      expect(items.find((w) => w.role_id === "pm")).toMatchObject({
        max_review_rounds: 3,
      });
      const product = present(items.find((w) => w.kind === "produce"));
      producer = f.commit(
        assign(
          f.state,
          pm,
          { work_item_id: product.id, role_id: product.role_id },
          f.io,
        ),
      );
      item = present(items.find((w) => w.role_id === "independent_reviewer"));
    }
    expect(item).toMatchObject({ kind: "verify", max_review_rounds: 2 });
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
      f.start(producer);
      const p = {
        work_item_id: present(producer.work_item_id),
        kind: "code" as const,
        summary: "Ready for review",
        subject: { kind: "git_head" as const, value: sha },
        requested_verifiers:
          source === "direct"
            ? [present(f.reviewer.work_item_id), item.id]
            : [item.id],
      };
      const proof = value(
        await prepareDelivery(f.state, f.actor(producer), p, {
          verify: async () => ({ ok: true, value: [] }),
        }),
      );
      return f.commit(
        submitDelivery(f.state, f.actor(producer), p, proof, f.io),
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
