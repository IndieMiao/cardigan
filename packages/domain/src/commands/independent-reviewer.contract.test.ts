import { expect, test } from "vitest";
import {
  type Actor,
  assign,
  createCard,
  createWorkItem,
  DEFAULT_INDEPENDENT_REVIEW_MAX_ROUNDS,
  DEFAULT_REVIEW_MAX_ROUNDS,
  developmentCardTemplate,
  manageCardTemplate,
  prepareDelivery,
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

const LIMIT = DEFAULT_INDEPENDENT_REVIEW_MAX_ROUNDS;

test("C-253: the default limits are 5 ordinary and 3 independent rounds", () => {
  expect(DEFAULT_REVIEW_MAX_ROUNDS).toBe(5);
  expect(LIMIT).toBe(3);
});

test.each([undefined, 1, 2, 3])(
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
    expect(item).toMatchObject({
      kind: "verify",
      max_review_rounds: max ?? LIMIT,
    });
    expect(f.state.work_items.find((w) => w.id === item.id)).toEqual(item);
  },
);

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
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

test("C-253: PM cannot create an independent review above the preference, the human can", () => {
  const { f, pm, params } = setup();
  expect(
    createWorkItem(
      f.state,
      pm,
      { ...params, max_review_rounds: LIMIT + 1 },
      f.io,
    ),
  ).toMatchObject({
    ok: false,
    error: {
      code: "validation_failed",
      message: expect.stringContaining(`${LIMIT} 轮`),
    },
  });
  expect(
    f.commit(
      createWorkItem(
        f.state,
        human,
        { ...params, max_review_rounds: LIMIT + 1 },
        f.io,
      ),
    ),
  ).toMatchObject({ max_review_rounds: LIMIT + 1 });
});

test("existing reviewers retain the global default and PM Ops limit controls", () => {
  const { f, pm, params } = setup();
  for (const max of [undefined, DEFAULT_REVIEW_MAX_ROUNDS + 1]) {
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
    expect(item).toMatchObject({
      max_review_rounds: max ?? DEFAULT_REVIEW_MAX_ROUNDS,
    });
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
  "invariant 11: $source independent review's last default round $verdict uses the existing limit state machine",
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
        max_review_rounds: DEFAULT_REVIEW_MAX_ROUNDS,
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
    expect(item).toMatchObject({ kind: "verify", max_review_rounds: LIMIT });
    const owner = f.commit(
      assign(
        f.state,
        pm,
        { work_item_id: item.id, role_id: item.role_id },
        f.io,
      ),
    );
    // PM cannot pre-empt the human escalation by widening the budget.
    const widen = (caller: Actor) =>
      updateWorkItem(
        f.state,
        caller,
        { work_item_id: item.id, max_review_rounds: LIMIT + 1 },
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
    const shas = ["a", "b", "c"].map((c) => c.repeat(40));
    expect(shas).toHaveLength(LIMIT);
    for (const [index, sha] of shas.entries()) {
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
      // Round LIMIT - 1 does not trigger the limit; only round LIMIT does.
      if (index < LIMIT - 1) expect(f.state.decisions).toEqual([]);
    }
    expect(
      f.state.reviews.filter((r) => r.work_item_id === item.id),
    ).toHaveLength(LIMIT);
    expect(f.state.work_items.find((w) => w.id === item.id)).toMatchObject({
      status:
        verdict === "pass"
          ? "passed"
          : verdict === "reject"
            ? "failed"
            : "in_progress",
      max_review_rounds: verdict === "reject" ? LIMIT + 1 : LIMIT,
    });
    expect(f.state.decisions).toEqual([]);
    expect(
      f.state.events.filter((e) => e.type === "review_limit_raised_by_system"),
    ).toHaveLength(verdict === "reject" ? 1 : 0);
  },
);
