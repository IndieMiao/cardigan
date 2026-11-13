import { beforeEach, expect, test } from "vitest";
import type { Actor, Delivery, Review, WorkItem } from "../entities.js";
import {
  assign,
  type CommandState,
  createCard,
  createWorkItem,
  deriveCardFields,
  deriveReviewMatrix,
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

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

function present<T>(entity: T | undefined): T {
  if (entity === undefined) throw new Error("Missing delivery fixture entity");
  return entity;
}

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

test.each([true, false])(
  "invariants 8, 14: review events retain conditions and allow same-version recheck (%s)",
  async (recheck_required) => {
    const product = value(await deliver());
    let state = apply(fixture(), product);
    const issues = [
      {
        severity: "minor" as const,
        description: "Clarify the validation evidence",
        must_fix: false,
        pre_existing: false,
        proof: "The report omits an expected result",
      },
    ];
    const result = value(
      submitReview(
        state,
        actor(2, "reviewer"),
        { ...reviewParams(product.data), recheck_required, issues },
        io,
      ),
    );
    expect(result.events[0]?.payload).toMatchObject({
      review_id: result.data.id,
      delivery_id: product.data.id,
      verdict: recheck_required ? "conditional" : "pass",
      recheck_required,
      rework_allowed: recheck_required,
      issues,
    });
    state = apply(state, result);
    expect(state.work_items.find((w) => w.id === p.work_item_id)?.status).toBe(
      recheck_required ? "delivered" : "accepted",
    );
    if (recheck_required) {
      state = {
        ...state,
        runs: [
          ...state.runs.map((r) =>
            r.id === id("run", 2) ? { ...r, status: "completed" as const } : r,
          ),
          { ...run(2), id: id("run", 99) },
        ],
      };
      const rechecked = value(
        submitReview(
          state,
          actor(2, "reviewer"),
          reviewParams(product.data),
          io,
        ),
      );
      expect(rechecked.data).toMatchObject({
        delivery_id: product.data.id,
        target_sha: product.data.subject.value,
        verdict: "pass",
      });
      expect(apply(state, rechecked).deliveries[0]?.status).toBe("accepted");
    }
  },
);

test("invariant 13: code review enables completion; the PM completion review opens the merge gate", async () => {
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
      plain_summary: TEST_PLAIN_SUMMARY,
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
  expect(state.cards.find((c) => c.id === id("card", 1))?.status).toBe(
    "awaiting_merge",
  );
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
      plain_summary: TEST_PLAIN_SUMMARY,
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
    plain_summary: TEST_PLAIN_SUMMARY,
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

test.each(["reject", "conditional", "pass"] as const)(
  "invariants 10, 11, 12: final review round with %s either passes or requests a decision",
  async (verdict) => {
    const initial = fixture();
    let state: CommandState = {
      ...initial,
      work_items: initial.work_items.map((w) =>
        w.kind === "verify" ? { ...w, max_review_rounds: 1 } : w,
      ),
    };
    const product = value(await deliver(state));
    state = apply(state, product);
    const result = value(
      submitReview(
        state,
        actor(2, "reviewer"),
        {
          ...reviewParams(product.data),
          recheck_required: verdict === "conditional",
          issues:
            verdict === "reject"
              ? [
                  {
                    severity: "major",
                    description: "Bug",
                    must_fix: true,
                    pre_existing: false,
                  },
                ]
              : [],
        },
        io,
      ),
    );
    expect(result.data.verdict).toBe(verdict);
    state = apply(state, result);
    expect(
      state.work_items.find((w) => w.id === id("work_item", 2))?.status,
    ).toBe(verdict === "pass" ? "passed" : "waiting_decision");
    expect(result.events.map((event) => event.type)).toEqual(
      verdict === "pass"
        ? ["review_submitted"]
        : ["review_submitted", "decision_requested"],
    );
    expect(result.events[0]?.payload).toMatchObject({ rework_allowed: false });
    if (verdict === "pass") {
      expect(state.decisions).toHaveLength(0);
      return;
    }
    expect(result.timeline.map((entry) => entry.type)).toEqual([
      "review",
      "decision_request",
    ]);
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]).toMatchObject({
      status: "open",
      blocking: true,
      affected_work_items: [id("work_item", 2)],
    });
    expect(state.runs.find((r) => r.id === id("run", 2))).toMatchObject({
      status: "completed",
      outcome: "blocked",
      role_version: 1,
      model: "fixture-model",
      agent_cli_version: "1.0",
    });
    expect(state.runs).toHaveLength(initial.runs.length);
    state = {
      ...state,
      runs: [...state.runs, { ...run(2), id: id("run", 99) }],
    };
    expect(
      submitReview(state, actor(2, "reviewer"), reviewParams(product.data), io),
    ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  },
);

test.each(["pending", "conditional", "rejected"] as const)(
  "invariants 13, 14: a new product withdraws a %s completion target and its next owner",
  async (status) => {
    let state = fixture();
    const product = value(await deliver(state));
    state = apply(state, product);
    state = apply(
      state,
      value(
        submitReview(
          state,
          actor(2, "reviewer"),
          reviewParams(product.data),
          io,
        ),
      ),
    );
    const completion = value(
      await deliver(state, {
        ...p,
        kind: "card_completion",
        plain_summary: TEST_PLAIN_SUMMARY,
        requested_verifiers: [id("work_item", 3)],
      }),
    );
    state = apply(state, completion);
    if (status !== "pending")
      state = apply(
        state,
        value(
          submitReview(
            state,
            actor(3, "pm"),
            {
              ...reviewParams(completion.data),
              recheck_required: status === "conditional",
              issues:
                status === "rejected"
                  ? [
                      {
                        severity: "major",
                        description: "Not ready",
                        must_fix: true,
                        pre_existing: false,
                      },
                    ]
                  : [],
            },
            io,
          ),
        ),
      );
    // Deliberately put the completion first: entity order must not choose the predecessor.
    state = { ...state, deliveries: [...state.deliveries].reverse() };
    const params = { ...p, subject: { ...subject, value: "b".repeat(40) } };
    expect(
      await deliver(state, { ...params, supersedes: completion.data.id }),
    ).toMatchObject({ ok: false, error: { code: "stale_target" } });
    expect(
      value(await deliver(state, { ...params, supersedes: product.data.id }))
        .data.supersedes,
    ).toBe(product.data.id);
    const next = value(await deliver(state, params));
    expect(next.data.supersedes).toBe(product.data.id);
    state = apply(state, next);
    expect(
      state.deliveries.find((d) => d.id === completion.data.id)?.status,
    ).toBe("superseded");
    expect(state.deliveries.find((d) => d.id === product.data.id)?.status).toBe(
      "superseded",
    );
    expect(
      state.work_items.find((w) => w.id === id("work_item", 3))?.status,
    ).toBe("todo");
    expect(
      state.work_items.find((w) => w.id === id("work_item", 2))?.status,
    ).toBe("ready");
    const card = state.cards.find((c) => c.id === id("card", 1));
    if (!card) throw new Error("Missing card");
    expect(deriveCardFields({ ...state, card }).next_owners).toEqual([
      { kind: "assignment", ref: id("assignment", 2) },
    ]);
    expect(
      submitReview(state, actor(3, "pm"), reviewParams(completion.data), io),
    ).toMatchObject({ ok: false, error: { code: "stale_target" } });
  },
);

/**
 * §4.4 (user ruling, 2026-11-06): a produce work item that no verification
 * points at is done when it is delivered.
 *
 * The state is built the way the product builds it: `createCard` for the
 * template, `createWorkItem` for the unreviewed product step, `assign` for the
 * Assignments, and one queued Run per Assignment, which is what the dispatcher
 * would open. Nothing here hand-writes a WorkItem.
 */
const office = actor(4, "pm");
const PM_TOOLS = [
  "whoami",
  "get_card",
  "submit_delivery",
  "create_card",
  "create_work_item",
  "assign",
];

/** The caller of a work-item Assignment, with the tool scope the role carries. */
function workActor(
  assignmentId: string,
  role_id: string,
  tools: readonly string[],
): Actor {
  return {
    kind: "assignment",
    project_id: "fixture-project",
    assignment_id: assignmentId as never,
    role_id,
    role_version: 1,
    allowed_tools: tools as never,
    capabilities: [role_id],
  };
}

function unreviewedSetup(options: { readonly dependent?: boolean } = {}) {
  const seed = fixture();
  let state: CommandState = {
    ...seed,
    cards: [],
    work_items: [],
    runs: [],
    assignments: seed.assignments.filter((entry) => entry.scope === "standing"),
  };
  const created = value(
    createCard(
      state,
      office,
      {
        title: "Unreviewed produce",
        goal: "Ship the confirmation",
        acceptance_criteria: ["Confirmed"],
        source: { kind: "quote", text: "Confirm" },
        repo: "example/repo",
        base_branch: "main",
      },
      io,
    ),
  );
  state = apply(state, created);

  const product = value(
    createWorkItem(
      state,
      office,
      {
        card_id: created.data.id,
        title: "产品确认",
        kind: "produce",
        role_id: "pm",
        required: true,
        completion_criteria: ["Confirmed"],
      },
      io,
    ),
  );
  state = apply(state, product);

  let dependent: WorkItem | undefined;
  if (options.dependent === true) {
    const next = value(
      createWorkItem(
        state,
        office,
        {
          card_id: created.data.id,
          title: "Split the release notes",
          kind: "produce",
          role_id: "coder",
          required: true,
          completion_criteria: ["Notes written"],
          depends_on: [product.data.id],
        },
        io,
      ),
    );
    state = apply(state, next);
    dependent = next.data;
  }

  const assigned = value(
    assign(state, office, { work_item_id: product.data.id, role_id: "pm" }, io),
  );
  state = apply(state, assigned);
  const started: CommandState = {
    ...state,
    runs: [
      ...state.runs,
      {
        ...run(1),
        id: io.ids.next(state.project_id, "run"),
        assignment_id: assigned.data.id,
      },
    ],
  };
  return {
    state: started,
    card: created.data.id,
    product: product.data,
    caller: workActor(assigned.data.id, "pm", PM_TOOLS),
    dependent,
  };
}

const unreviewedDelivery: SubmitDeliveryParams = {
  work_item_id: "" as never,
  kind: "doc",
  summary: "需求已确认",
  subject: { kind: "doc_version", value: "product-v1" },
  requested_verifiers: [],
};

async function deliverUnreviewed(
  setup: ReturnType<typeof unreviewedSetup>,
  requested: readonly string[] = [],
) {
  const params = {
    ...unreviewedDelivery,
    work_item_id: setup.product.id,
    requested_verifiers: requested as never,
  };
  return deliver(setup.state, params, setup.caller);
}

test("§4.4: a produce item nothing verifies is accepted on delivery, with a timeline note", async () => {
  const setup = unreviewedSetup();
  const result = value(await deliverUnreviewed(setup));

  expect(result.data.status).toBe("accepted");
  expect(result.data.requested_verifiers).toEqual([]);

  const after = apply(setup.state, result);
  expect(
    after.work_items.find((item) => item.id === setup.product.id)?.status,
  ).toBe("accepted");
  const note = result.timeline.find((entry) => entry.type === "system");
  expect(note?.body).toContain("无需审核");
  expect(note?.delivery_id).toBe(result.data.id);
});

test("§4.4: a dependent item stays todo until its own Run activates it", async () => {
  const setup = unreviewedSetup({ dependent: true });
  const result = value(await deliverUnreviewed(setup));
  let state = apply(setup.state, result);

  const dependent = present(setup.dependent);
  // Lazy activation: acceptance alone does not move the dependent item.
  expect(
    state.work_items.find((item) => item.id === dependent.id)?.status,
  ).toBe("todo");

  // Its own Run does: the first command in that Run goes through
  // `dependencies_met` and `run_started` because its dependency succeeded.
  const assigned = value(
    assign(state, office, { work_item_id: dependent.id, role_id: "coder" }, io),
  );
  state = apply(state, assigned);
  const runId = io.ids.next(state.project_id, "run");
  state = {
    ...state,
    runs: [
      ...state.runs,
      { ...run(1), id: runId, assignment_id: assigned.data.id },
    ],
  };
  const produced = value(
    await deliver(
      state,
      {
        work_item_id: dependent.id,
        kind: "doc",
        summary: "notes",
        subject: { kind: "doc_version", value: "notes-v1" },
        requested_verifiers: [],
      },
      workActor(assigned.data.id, "coder", PM_TOOLS),
    ),
  );
  state = apply(state, produced);
  expect(
    state.work_items.find((item) => item.id === dependent.id)?.status,
  ).toBe("accepted");
});

test("§4.4: an unfinished dependency still blocks the dependent Run", async () => {
  const setup = unreviewedSetup({ dependent: true });
  const dependent = present(setup.dependent);
  let state = setup.state;
  const assigned = value(
    assign(state, office, { work_item_id: dependent.id, role_id: "coder" }, io),
  );
  state = apply(state, assigned);
  const runId = io.ids.next(state.project_id, "run");
  state = {
    ...state,
    runs: [
      ...state.runs,
      { ...run(1), id: runId, assignment_id: assigned.data.id },
    ],
  };
  const blocked = await deliver(
    state,
    {
      work_item_id: dependent.id,
      kind: "doc",
      summary: "notes",
      subject: { kind: "doc_version", value: "notes-v1" },
      requested_verifiers: [],
    },
    workActor(assigned.data.id, "coder", PM_TOOLS),
  );
  expect(blocked.ok).toBe(false);
  if (blocked.ok) return;
  expect(blocked.error.code).toBe("invariant_violation");
});

test("§4.4: a verified produce item still requires its verifiers", async () => {
  // The template's development item is verified by code_review: an empty request
  // is refused and the delivery stays `submitted` until the review passes.
  const refused = await deliver(fixture(), {
    ...p,
    requested_verifiers: [],
  } as SubmitDeliveryParams);
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.error.code).toBe("validation_failed");

  const accepted = value(await deliver());
  expect(accepted.data.status).toBe("submitted");
  const after = apply(fixture(), accepted);
  expect(
    after.work_items.find((w) => w.id === id("work_item", 1))?.status,
  ).toBe("delivered");
});

test("§4.4: an unreviewed delivery may not name somebody else's verifier", async () => {
  const setup = unreviewedSetup();
  const refused = await deliverUnreviewed(setup, [id("work_item", 2)]);
  // The verifier does not target the product item, and the item has none.
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.error.code).toBe("validation_failed");
});

/**
 * M5.S S16: the review matrix must not ask a completion request for the code
 * review. Built from real `createCard` and `assign` output (template work items
 * and per-item Assignments), then driven through the real delivery/review
 * commands, so the mapping is checked against the product's own state.
 */
function completionMatrixSetup() {
  const office = actor(4, "pm");
  const seed = fixture();
  let state: CommandState = {
    ...seed,
    cards: [],
    work_items: [],
    runs: [],
    deliveries: [],
    reviews: [],
    assignments: seed.assignments.filter((entry) => entry.scope === "standing"),
  };
  const created = value(
    createCard(
      state,
      office,
      {
        title: "Completion matrix",
        goal: "Check the matrix",
        acceptance_criteria: ["Pass"],
        source: { kind: "quote", text: "Pass" },
        repo: "example/repo",
        base_branch: "main",
      },
      io,
    ),
  );
  state = apply(state, created);
  const items = state.work_items.filter(
    (item) => item.card_id === created.data.id,
  );
  const produce = present(items.find((item) => item.kind === "produce"));
  const codeReview = present(
    items.find((item) => item.template_key === "code_review"),
  );
  const acceptance = present(
    items.find((item) => item.template_key === "pm_acceptance"),
  );
  const callers = new Map<WorkItem["id"], Actor>();
  for (const [item, role, tools] of [
    [produce, "coder", PM_TOOLS],
    [codeReview, "reviewer", ["whoami", "submit_review", "finish_run"]],
    [acceptance, "pm", ["whoami", "submit_review", "finish_run"]],
  ] as const) {
    const assigned = value(
      assign(state, office, { work_item_id: item.id, role_id: role }, io),
    );
    state = apply(state, assigned);
    callers.set(
      item.id,
      workActor(assigned.data.id, role, tools as readonly string[]),
    );
    state = {
      ...state,
      runs: [
        ...state.runs,
        {
          ...run(1),
          id: io.ids.next(state.project_id, "run"),
          assignment_id: assigned.data.id,
        },
      ],
    };
  }
  return {
    state,
    produce,
    codeReview,
    acceptance,
    coder: present(callers.get(produce.id)),
    reviewer: present(callers.get(codeReview.id)),
    pm: present(callers.get(acceptance.id)),
  };
}

test("M5.S S16: a completion request only waits on the PM acceptance item", async () => {
  const setup = completionMatrixSetup();
  const product = value(
    await deliver(
      setup.state,
      {
        work_item_id: setup.produce.id,
        kind: "code",
        summary: "Ready",
        subject,
        requested_verifiers: [setup.codeReview.id],
      },
      setup.coder,
    ),
  );
  let state = apply(setup.state, product);
  const codeReview = value(
    submitReview(
      state,
      setup.reviewer,
      {
        delivery_id: product.data.id,
        target_sha: product.data.subject.value,
        kind: "code",
        issues: [],
      },
      io,
    ),
  );
  state = apply(state, codeReview);
  const completion = value(
    await deliver(
      state,
      {
        work_item_id: setup.produce.id,
        kind: "card_completion",
        plain_summary: TEST_PLAIN_SUMMARY,
        summary: "Complete",
        subject,
        requested_verifiers: [setup.acceptance.id],
      },
      setup.coder,
    ),
  );
  state = apply(state, completion);
  const acceptance = value(
    submitReview(
      state,
      setup.pm,
      {
        delivery_id: completion.data.id,
        target_sha: completion.data.subject.value,
        kind: "product",
        issues: [],
      },
      io,
    ),
  );
  state = apply(state, acceptance);

  const matrix = deriveReviewMatrix(
    state.deliveries,
    state.work_items,
    state.reviews,
  );
  expect(
    matrix.map((cell) => [cell.delivery_id, cell.work_item_id, cell.verdict]),
  ).toEqual([
    [product.data.id, setup.codeReview.id, "pass"],
    [completion.data.id, setup.acceptance.id, "pass"],
  ]);
});
