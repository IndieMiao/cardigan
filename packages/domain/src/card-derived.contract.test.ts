import { describe, expect, expectTypeOf, test } from "vitest";
import {
  type Assignment,
  type Card,
  type CardDerivedInput,
  type CardView,
  type Decision,
  type Delivery,
  deriveCardFields,
  deriveNextOwners,
  deriveReviewMatrix,
  deriveWaitingOn,
  deriveWhy,
  type HumanAction,
  type Review,
  WHY_MAX_LENGTH,
  type WorkItem,
} from "./index.js";

const card: Card = {
  id: "C-1" as never,
  project_id: "p",
  title: "Fictional card",
  goal: "",
  acceptance_criteria: [],
  source: { kind: "quote", text: "" },
  out_of_scope: [],
  related_cards: [],
  repo: "example/repo",
  base_branch: "main",
  priority: 1,
  status: "todo",
  template: "dev",
  created_by: "human",
  created_at: "2026-01-01T00:00:00.000Z",
};

function produce(status: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "W-1" as never,
    card_id: card.id,
    title: "Development",
    kind: "produce",
    role_id: "coder",
    required: true,
    depends_on: [],
    completion_criteria: [],
    status,
    ...overrides,
  } as WorkItem;
}

function verify(
  id: string,
  status: string,
  overrides: Partial<WorkItem> = {},
): WorkItem {
  return {
    id: id as never,
    card_id: card.id,
    title: "Review",
    kind: "verify",
    role_id: "reviewer",
    required: true,
    depends_on: [],
    completion_criteria: [],
    status,
    max_review_rounds: 2,
    ...overrides,
  } as WorkItem;
}

function delivery(id: string, overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: id as never,
    work_item_id: "W-1" as never,
    run_id: "R-1" as never,
    kind: "code",
    summary: `${id} summary`,
    subject: { kind: "git_head", value: `sha-${id}` },
    evidence: [],
    attachments: [],
    known_gaps: [],
    requested_verifiers: [],
    status: "submitted",
    ...overrides,
  };
}

function review(
  deliveryId: string,
  verifyId: string,
  overrides: Partial<Review> = {},
): Review {
  return {
    id: "V-1" as never,
    delivery_id: deliveryId as never,
    target_sha: `sha-${deliveryId}`,
    work_item_id: verifyId as never,
    run_id: "R-1" as never,
    kind: "code",
    issues: [],
    verdict: "pass",
    blocking: false,
    recheck_required: false,
    attachments: [],
    ...overrides,
  };
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "q(1)" as never,
    key: "q(1)" as never,
    kind: "choose",
    card_id: card.id,
    raised_by: "human",
    question: "fictional question",
    context: "",
    options: [],
    recommended: "a",
    affected_cards: [],
    affected_work_items: [],
    blocking: true,
    decider: "human",
    doc_refs: [],
    status: "open",
    ...overrides,
  } as Decision;
}

function humanAction(overrides: Partial<HumanAction> = {}): HumanAction {
  return {
    id: "h(1)" as never,
    key: "h(1)" as never,
    card_id: card.id,
    requested_by: "human",
    instructions: "run the fictional command",
    why_human: "needs credentials",
    expected_return: "the output",
    blocked_work_items: [],
    status: "open",
    ...overrides,
  } as HumanAction;
}

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: "A-1" as never,
    scope: "work_item",
    work_item_id: "W-1" as never,
    role_id: "coder",
    role_version: 1,
    status: "active",
    runtime_state: "not_running" as never,
    machine_id: "local",
    runtime_ref: null,
    mcp_token_id: "t",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Assignment;
}

/** A project-level decision that only lists this card under affected_cards. */
function projectLevelDecision(options: {
  readonly id: string;
  readonly affected_cards: readonly Card["id"][];
}): Decision {
  const base = decision({ id: options.id as never, key: options.id as never });
  const { card_id: _card_id, ...rest } = base;
  return { ...rest, affected_cards: [...options.affected_cards] } as Decision;
}

function input(overrides: Partial<CardDerivedInput> = {}): CardDerivedInput {
  return {
    card,
    work_items: [produce("todo")],
    assignments: [],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    ...overrides,
  };
}

describe("waiting_on", () => {
  test("includes an unresolved blocking decision", () => {
    const waiting = deriveWaitingOn(input({ decisions: [decision()] }));
    expect(waiting).toEqual([
      { kind: "decision", ref: "q(1)", label: "等你拍板 q(1)" },
    ]);
  });

  test("ignores resolved, non-blocking and unrelated decisions", () => {
    for (const overrides of [
      { status: "resolved" } as const,
      { status: "withdrawn" } as const,
      { blocking: false } as const,
      { card_id: "C-2" as never, affected_cards: ["C-3" as never] },
    ]) {
      expect(
        deriveWaitingOn(input({ decisions: [decision(overrides as never)] })),
      ).toEqual([]);
    }
  });

  test("includes a provisional decision and one that only lists affected cards", () => {
    const waiting = deriveWaitingOn(
      input({
        decisions: [
          decision({
            id: "q(2)" as never,
            key: "q(2)" as never,
            status: "provisional",
          }),
          projectLevelDecision({ id: "q(3)", affected_cards: [card.id] }),
        ],
      }),
    );
    expect(waiting.map((item) => item.ref)).toEqual(["q(2)", "q(3)"]);
  });

  test("includes a pending human action for the card or its work items", () => {
    expect(
      deriveWaitingOn(input({ human_actions: [humanAction()] })).map(
        (i) => i.ref,
      ),
    ).toEqual(["h(1)"]);

    const viaWorkItem = humanAction({
      card_id: undefined,
      blocked_work_items: ["W-1" as never],
    } as never);
    expect(
      deriveWaitingOn(input({ human_actions: [viaWorkItem] })).map(
        (i) => i.ref,
      ),
    ).toEqual(["h(1)"]);

    // Done, cancelled and unrelated actions are not waiting.
    for (const overrides of [
      { status: "done" } as const,
      { status: "cancelled" } as const,
      { card_id: "C-2" as never },
    ]) {
      expect(
        deriveWaitingOn(
          input({ human_actions: [humanAction(overrides as never)] }),
        ),
      ).toEqual([]);
    }
  });

  test("includes a verify work item whose delivery has no conclusion", () => {
    const waiting = deriveWaitingOn(
      input({
        work_items: [
          produce("delivered"),
          verify("W-2", "ready", { target_work_item_id: "W-1" as never }),
        ],
        deliveries: [delivery("D-1")],
      }),
    );
    expect(waiting).toEqual([
      { kind: "review", ref: "W-2", label: "等待 reviewer 审核 D-1" },
    ]);
  });

  test("drops the review wait once the current version is reviewed", () => {
    const waiting = deriveWaitingOn(
      input({
        work_items: [
          produce("delivered"),
          verify("W-2", "ready", { target_work_item_id: "W-1" as never }),
        ],
        deliveries: [delivery("D-1")],
        reviews: [review("D-1", "W-2")],
      }),
    );
    expect(waiting).toEqual([]);
  });

  test("ignores a review whose target SHA is an older version", () => {
    const waiting = deriveWaitingOn(
      input({
        work_items: [
          produce("delivered"),
          verify("W-2", "ready", { target_work_item_id: "W-1" as never }),
        ],
        deliveries: [delivery("D-1")],
        reviews: [review("D-1", "W-2", { target_sha: "sha-old" })],
      }),
    );
    expect(waiting.map((item) => item.kind)).toEqual(["review"]);
  });

  test("waits on the current delivery, not a superseded one", () => {
    const waiting = deriveWaitingOn(
      input({
        work_items: [
          produce("delivered"),
          verify("W-2", "ready", { target_work_item_id: "W-1" as never }),
        ],
        deliveries: [
          delivery("D-1", { status: "superseded" }),
          delivery("D-2", { supersedes: "D-1" as never }),
        ],
        reviews: [review("D-1", "W-2")],
      }),
    );
    expect(waiting).toEqual([
      { kind: "review", ref: "W-2", label: "等待 reviewer 审核 D-2" },
    ]);
  });

  test("waits on the completion request for a verify item without a target", () => {
    const completion = delivery("D-9", {
      kind: "card_completion",
      summary: "completion request",
    });
    const waiting = deriveWaitingOn(
      input({
        work_items: [produce("delivered"), verify("W-3", "ready")],
        deliveries: [completion],
      }),
    );
    expect(waiting).toEqual([
      { kind: "review", ref: "W-3", label: "等待 reviewer 审核 D-9" },
    ]);

    // An accepted or rejected completion request is no longer waiting.
    expect(
      deriveWaitingOn(
        input({
          work_items: [produce("delivered"), verify("W-3", "ready")],
          deliveries: [{ ...completion, status: "accepted" }],
        }),
      ),
    ).toEqual([]);
  });

  test("does not wait for review before the target has a delivery", () => {
    expect(
      deriveWaitingOn(
        input({
          work_items: [
            produce("in_progress"),
            verify("W-2", "todo", { target_work_item_id: "W-1" as never }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("includes blocked work items", () => {
    const waiting = deriveWaitingOn(
      input({ work_items: [produce("blocked"), verify("W-2", "blocked")] }),
    );
    expect(waiting.map((item) => item.kind)).toEqual(["blocked", "blocked"]);
    expect(waiting.map((item) => item.ref)).toEqual(["W-1", "W-2"]);
  });

  test("keeps the plan's order when several kinds wait at once", () => {
    const waiting = deriveWaitingOn(
      input({
        work_items: [
          produce("blocked"),
          verify("W-2", "ready", { target_work_item_id: "W-1" as never }),
        ],
        deliveries: [delivery("D-1")],
        decisions: [decision()],
        human_actions: [humanAction()],
      }),
    );
    expect(waiting.map((item) => item.kind)).toEqual([
      "decision",
      "human_action",
      "review",
      "blocked",
    ]);
  });
});

describe("next_owners", () => {
  test("starts with the blocking decision's decider", () => {
    expect(
      deriveNextOwners(input({ decisions: [decision({ decider: "human" })] })),
    ).toEqual([{ kind: "human", ref: "human" }]);

    expect(
      deriveNextOwners(
        input({ decisions: [decision({ decider: "role:pm" } as never)] }),
      ),
    ).toEqual([{ kind: "role", ref: "pm" }]);
  });

  test("adds a human owner for a pending human action", () => {
    expect(deriveNextOwners(input({ human_actions: [humanAction()] }))).toEqual(
      [{ kind: "human", ref: "human" }],
    );
  });

  test.each(["active", "suspended"] as const)(
    "points active work items at their %s assignment",
    (status) => {
      for (const workStatus of ["ready", "in_progress", "changes_requested"]) {
        const owners = deriveNextOwners(
          input({
            work_items: [
              produce(workStatus, { assignment_id: "A-1" as never }),
            ],
            assignments: [assignment({ status })],
          }),
        );
        expect(owners).toEqual([{ kind: "assignment", ref: "A-1" }]);
      }
    },
  );

  test.each(["ready", "in_progress", "changes_requested"])(
    "falls back to the work item's role for a released assignment (%s)",
    (status) => {
      const owners = deriveNextOwners(
        input({
          work_items: [produce(status, { assignment_id: "A-1" as never })],
          assignments: [assignment({ status: "released" })],
        }),
      );
      expect(owners).toEqual([{ kind: "role", ref: "coder" }]);
    },
  );

  test("de-duplicates the role across released and unassigned work items", () => {
    const owners = deriveNextOwners(
      input({
        work_items: [
          produce("in_progress", { assignment_id: "A-1" as never }),
          produce("ready", {
            id: "W-2" as never,
            assignment_id: "A-2" as never,
          }),
          produce("changes_requested", { id: "W-3" as never }),
        ],
        assignments: [
          assignment({ status: "released" }),
          assignment({
            id: "A-2" as never,
            work_item_id: "W-2" as never,
            status: "released",
          }),
        ],
      }),
    );
    expect(owners).toEqual([{ kind: "role", ref: "coder" }]);
  });

  test("falls back to the role when no assignment exists yet", () => {
    for (const status of ["ready", "in_progress", "changes_requested"]) {
      expect(
        deriveNextOwners(input({ work_items: [produce(status)] })),
      ).toEqual([{ kind: "role", ref: "coder" }]);
    }
  });

  test("ignores finished and future work items", () => {
    for (const status of [
      "todo",
      "delivered",
      "accepted",
      "blocked",
      "cancelled",
    ]) {
      expect(
        deriveNextOwners(input({ work_items: [produce(status)] })),
      ).toEqual([]);
    }
  });

  test("asks the template reviewer for a submitted completion request", () => {
    const owners = deriveNextOwners(
      input({
        work_items: [produce("delivered")],
        deliveries: [
          delivery("D-1"),
          delivery("D-9", { kind: "card_completion", summary: "done" }),
        ],
      }),
    );
    // The dev template's completion reviewer is `role:pm`.
    expect(owners).toEqual([{ kind: "role", ref: "pm" }]);
  });

  test("uses an explicit template override", () => {
    const owners = deriveNextOwners(
      input({
        deliveries: [delivery("D-9", { kind: "card_completion" })],
        template: { completion_reviewer: "human" },
      }),
    );
    expect(owners).toEqual([{ kind: "human", ref: "human" }]);
  });

  test("de-duplicates owners and keeps the priority order", () => {
    const owners = deriveNextOwners(
      input({
        work_items: [
          produce("in_progress", { assignment_id: "A-1" as never }),
          produce("ready", { id: "W-2" as never, role_id: "coder" }),
          produce("ready", { id: "W-3" as never, role_id: "designer" }),
        ],
        assignments: [assignment()],
        decisions: [decision({ decider: "role:coder" } as never)],
        human_actions: [humanAction()],
      }),
    );
    expect(owners).toEqual([
      { kind: "role", ref: "coder" },
      { kind: "human", ref: "human" },
      { kind: "assignment", ref: "A-1" },
      { kind: "role", ref: "designer" },
    ]);
  });
});

describe("why", () => {
  test("priorities follow the plan", () => {
    const cases: Array<[Partial<CardDerivedInput>, string]> = [
      [
        {
          decisions: [decision()],
          human_actions: [humanAction()],
        },
        "等你拍板 q(1)",
      ],
      [{ human_actions: [humanAction()] }, "等你执行 h(1)"],
      [
        { deliveries: [delivery("D-9", { kind: "card_completion" })] },
        "等待完成审核",
      ],
      [
        {
          work_items: [
            produce("delivered"),
            verify("W-2", "ready", { target_work_item_id: "W-1" as never }),
          ],
          deliveries: [delivery("D-1")],
        },
        "等待 reviewer 审核 D-1",
      ],
      [{ work_items: [produce("changes_requested")] }, "coder 返工中"],
      [{ work_items: [produce("in_progress")] }, "进行中"],
      [{ work_items: [produce("todo")] }, "待规划"],
      [{ card: { ...card, status: "done" } }, "已完成"],
      [{ card: { ...card, status: "cancelled" } }, "已取消"],
    ];

    for (const [overrides, expected] of cases) {
      expect(deriveWhy(input(overrides))).toBe(expected);
    }
  });

  test("counts multiple decisions", () => {
    const why = deriveWhy(
      input({
        decisions: [
          decision(),
          decision({ id: "q(2)" as never, key: "q(2)" as never }),
          decision({ id: "q(3)" as never, key: "q(3)" as never }),
        ],
      }),
    );
    expect(why).toBe("等你拍板 q(1) 等 3 项");
  });

  test("a card in progress with a delivered item still says in progress", () => {
    expect(
      deriveWhy(
        input({
          card: { ...card, status: "in_progress" },
          work_items: [produce("delivered")],
        }),
      ),
    ).toBe("进行中");
  });

  test("never exceeds the limit, for every rule", () => {
    const longId = "q(9999999999999999999)" as never;
    const variants: Array<Partial<CardDerivedInput>> = [
      { decisions: [decision({ id: longId, key: longId })] },
      {
        human_actions: [
          humanAction({
            id: "h(999999999999)" as never,
            key: "h(999999999999)" as never,
          }),
        ],
      },
      { deliveries: [delivery("D-9", { kind: "card_completion" })] },
      {
        work_items: [
          produce("delivered"),
          verify("W-2", "ready", {
            role_id: "a-very-long-role-identifier-name",
            target_work_item_id: "W-1" as never,
          }),
        ],
        deliveries: [delivery("D-1")],
      },
      {
        work_items: [
          produce("changes_requested", {
            role_id: "a-very-long-role-identifier-name",
          }),
        ],
      },
      { work_items: [produce("in_progress")] },
      { work_items: [produce("todo")] },
      { card: { ...card, status: "done" } },
    ];

    for (const overrides of variants) {
      const why = deriveWhy(input(overrides));
      expect(Array.from(why).length).toBeLessThanOrEqual(WHY_MAX_LENGTH);
    }
  });
});

describe("deriveCardFields", () => {
  test("returns all three fields consistently", () => {
    const fields = deriveCardFields(
      input({
        work_items: [
          produce("blocked"),
          verify("W-2", "ready", { target_work_item_id: "W-1" as never }),
        ],
        assignments: [assignment({ id: "A-2" as never })],
        deliveries: [delivery("D-1")],
        decisions: [decision({ decider: "role:pm" } as never)],
      }),
    );

    expect(fields.waiting_on.map((item) => item.kind)).toEqual([
      "decision",
      "review",
      "blocked",
    ]);
    expect(fields.next_owners[0]).toEqual({ kind: "role", ref: "pm" });
    expect(fields.why).toBe("等你拍板 q(1)");
  });

  test("an empty card is in planning with nothing to wait for", () => {
    expect(deriveCardFields({ ...input(), work_items: [] })).toEqual({
      waiting_on: [],
      next_owners: [],
      why: "待规划",
    });
  });
});

describe("CardView types", () => {
  test("the derived fields compose into a CardView", () => {
    const work_items = [
      produce("delivered"),
      verify("W-2", "ready", { target_work_item_id: "W-1" as never }),
    ];
    const deliveries = [delivery("D-1")];
    const reviews = [review("D-1", "W-2")];
    const fields = deriveCardFields(input({ work_items, deliveries, reviews }));

    // Type level: `CardView.waiting_on` / `next_owners` are the item shapes
    // from card-derived.ts, so the derived output fits without a cast.
    expectTypeOf(fields.waiting_on).toMatchTypeOf<CardView["waiting_on"]>();
    expectTypeOf(fields.next_owners).toMatchTypeOf<CardView["next_owners"]>();

    const view: CardView = {
      ...card,
      ...fields,
      open_decisions: [],
      review_matrix: deriveReviewMatrix(deliveries, work_items, reviews),
    };

    expect(view.waiting_on).toEqual(fields.waiting_on);
    expect(view.next_owners).toEqual(fields.next_owners);
    expect(view.why).toBe(fields.why);
  });

  test("CardView no longer accepts bare id arrays", () => {
    const fields = deriveCardFields(input());
    const legacy = {
      ...card,
      ...fields,
      // The old shape (an array of ids) must not typecheck as CardView.
      // @ts-expect-error waiting_on is WaitingOnItem[], not string[].
      waiting_on: ["q(1)"],
      // @ts-expect-error next_owners is NextOwnerItem[], not string[].
      next_owners: ["A-1"],
      open_decisions: [],
      review_matrix: [],
    } satisfies CardView;

    expect(legacy.waiting_on).toEqual(["q(1)"]);
  });
});
