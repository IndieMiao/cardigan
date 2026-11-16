import { beforeEach, expect, test } from "vitest";
import {
  type Actor,
  assign,
  type CommandState,
  canStartWork,
  createCard,
  createWorkItem,
  type Delivery,
  finishRun,
  prepareDelivery,
  reportBlocker,
  requestDecision,
  requestHumanAction,
  submitDelivery,
  submitReview,
  transition,
  type WorkItem,
  type WorkItemId,
} from "../index.js";
import {
  actor,
  apply,
  fixture,
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

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing workflow fixture entity");
  return value;
}
let io = ports();
beforeEach(() => {
  io = ports();
});
const office = actor(4, "pm");
const issue = {
  severity: "major" as const,
  description: "Bug",
  must_fix: true,
  pre_existing: false,
};
function setup(limit?: number) {
  const seed = fixture();
  let state: CommandState = {
    ...seed,
    cards: [],
    work_items: [],
    runs: [],
    assignments: seed.assignments.filter((a) => a.scope === "standing"),
  };
  const created = value(
    createCard(
      state,
      office,
      {
        title: "Real workflow",
        goal: "Ship",
        acceptance_criteria: ["Pass"],
        source: { kind: "quote", text: "Build" },
        repo: "example/repo",
        base_branch: "main",
      },
      io,
    ),
  );
  state = apply(state, created);
  let producer: WorkItem = present(
    state.work_items.find((w) => w.kind === "produce"),
  );
  let verifier = present(
    state.work_items.find((w) => w.template_key === "code_review"),
  );
  const other = present(
    state.work_items.find((w) => w.template_key === "pm_acceptance"),
  );
  if (limit !== undefined) {
    const extra = value(
      createWorkItem(
        state,
        office,
        {
          card_id: created.data.id,
          title: "Extra product",
          kind: "produce",
          role_id: "coder",
          required: false,
          completion_criteria: ["Pass"],
        },
        io,
      ),
    );
    state = apply(state, extra);
    producer = extra.data;
    const check = value(
      createWorkItem(
        state,
        office,
        {
          card_id: created.data.id,
          title: "Limited review",
          kind: "verify",
          role_id: "reviewer",
          required: true,
          completion_criteria: ["Pass"],
          target_work_item_id: producer.id,
          max_review_rounds: limit,
        },
        io,
      ),
    );
    state = apply(state, check);
    verifier = check.data;
  }
  const callers: Actor[] = [];
  for (const item of [producer, verifier]) {
    const assigned = value(
      assign(
        state,
        office,
        { work_item_id: item.id, role_id: item.role_id },
        io,
      ),
    );
    state = apply(state, assigned);
    const caller = actor(1, item.role_id);
    if (caller.kind !== "assignment")
      throw new Error("Expected an assignment actor");
    callers.push({ ...caller, assignment_id: assigned.data.id });
    // The outer dispatcher starts a Run; it does not mutate the WorkItem.
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
    card: created.data.id,
    producer: producer.id,
    verifier: verifier.id,
    other: other.id,
    coder: present(callers[0]),
    reviewer: present(callers[1]),
  };
}
type Context = ReturnType<typeof setup>;
const item = (state: CommandState, id: WorkItemId) =>
  present(state.work_items.find((w) => w.id === id));
const decisionParams = (ctx: Context) => ({
  card_id: ctx.card,
  category: "general" as const,
  kind: "choose" as const,
  question: "Choose",
  context: "Need an answer",
  options: [{ key: "go", description: "Continue", impact: "Unblocks" }],
  recommended: "go",
  affected_cards: [],
  affected_work_items: [],
  blocking: true,
  decider: "human" as const,
  plain_summary: TEST_PLAIN_SUMMARY,
});
const actionParams = (ctx: Context, id: WorkItemId) => ({
  card_id: ctx.card,
  instructions: "Connect device",
  why_human: "Physical access",
  expected_return: "Connected",
  blocked_work_items: [id],
});
const actions = ["blocker", "decision", "human_action"] as const;
function pause(
  ctx: Context,
  state: CommandState,
  action: (typeof actions)[number],
  caller = ctx.coder,
  id = ctx.producer,
) {
  if (action === "blocker")
    return reportBlocker(
      state,
      caller,
      { work_item_id: id, needs: "role", reason: "Need help" },
      io,
    );
  if (action === "decision")
    return requestDecision(state, caller, decisionParams(ctx), io);
  return requestHumanAction(state, caller, actionParams(ctx, id), io);
}
async function deliver(ctx: Context, state: CommandState, sha = subject.value) {
  const params = {
    work_item_id: ctx.producer,
    kind: "code" as const,
    summary: "Ready",
    subject: { ...subject, value: sha },
    requested_verifiers: [ctx.verifier],
  };
  const receipt = value(
    await prepareDelivery(state, ctx.coder, params, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  return value(submitDelivery(state, ctx.coder, params, receipt, io));
}
function review(
  ctx: Context,
  state: CommandState,
  delivery: Delivery,
  reject = false,
) {
  return value(
    submitReview(
      state,
      ctx.reviewer,
      {
        delivery_id: delivery.id,
        target_sha: delivery.subject.value,
        kind: "code",
        issues: reject ? [issue] : [],
      },
      io,
    ),
  );
}

test.each(actions)(
  "invariants 10, 11: createCard todo work can enter %s in its first Run",
  (action) => {
    const ctx = setup();
    expect(ctx.state.work_items.every((w) => w.status === "todo")).toBe(true);
    const result = pause(ctx, ctx.state, action);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    const after = apply(ctx.state, result.value);
    expect(item(after, ctx.producer).status).toBe(
      action === "decision" ? "waiting_decision" : "blocked",
    );
    expect(item(ctx.state, ctx.producer).status).toBe("todo");
    expect(item(after, ctx.verifier).status).toBe("todo");
  },
);

test.each(actions)(
  "invariants 10, 11: ready and real rejected produce work can enter %s",
  async (action) => {
    const ctx = setup();
    const ready: CommandState = {
      ...ctx.state,
      work_items: ctx.state.work_items.map((w) =>
        w.id === ctx.producer
          ? ({
              ...w,
              status: value(transition("produce", "todo", "dependencies_met")),
            } as typeof w)
          : w,
      ),
    };
    expect(pause(ctx, ready, action).ok).toBe(true);
    const product = await deliver(ctx, ctx.state);
    let state = apply(ctx.state, product);
    state = apply(state, review(ctx, state, product.data, true));
    expect(item(state, ctx.producer).status).toBe("changes_requested");
    expect(pause(ctx, state, action).ok).toBe(true);
  },
);

test.each(actions)(
  "invariant 11: a verifier made ready by delivery can enter %s",
  async (action) => {
    const ctx = setup();
    const product = await deliver(ctx, ctx.state);
    const state = apply(ctx.state, product);
    expect(item(state, ctx.verifier).status).toBe("ready");
    const result = pause(ctx, state, action, ctx.reviewer, ctx.verifier);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(item(apply(state, result.value), ctx.verifier).status).toBe(
      action === "decision" ? "waiting_decision" : "blocked",
    );
  },
);

test("invariant 11: activation checks dependencies and requires the caller's running Run", async () => {
  const ctx = setup();
  const dependency = {
    ...ctx.state,
    work_items: ctx.state.work_items.map((w) =>
      w.id === ctx.producer ? { ...w, depends_on: [ctx.other] } : w,
    ),
  };
  for (const action of actions)
    expect(pause(ctx, dependency, action)).toMatchObject({
      ok: false,
      error: {
        code: "invariant_violation",
        message: expect.stringContaining(ctx.producer),
      },
    });
  const params = {
    work_item_id: ctx.producer,
    kind: "code" as const,
    summary: "Ready",
    subject,
    requested_verifiers: [ctx.verifier],
  };
  const receipt = value(
    await prepareDelivery(dependency, ctx.coder, params, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  expect(
    submitDelivery(dependency, ctx.coder, params, receipt, io),
  ).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
  for (const action of actions)
    expect(pause(ctx, { ...ctx.state, runs: [] }, action)).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
});

test.each(["delivered", "accepted"] as const)(
  "invariants 8, 10, 11: %s producers are not implicitly paused and explicit pauses explain why",
  async (status) => {
    const ctx = setup();
    const product = await deliver(ctx, ctx.state);
    let state = apply(ctx.state, product);
    if (status === "accepted")
      state = apply(state, review(ctx, state, product.data));
    const requested = value(
      requestDecision(state, ctx.coder, decisionParams(ctx), io),
    );
    expect(requested.data.affected_work_items).toEqual([]);
    expect(apply(state, requested).runs).toEqual(state.runs);
    expect(item(apply(state, requested), ctx.producer).status).toBe(status);
    const results = [
      pause(ctx, state, "blocker"),
      pause(ctx, state, "human_action"),
      requestDecision(
        state,
        ctx.coder,
        { ...decisionParams(ctx), affected_work_items: [ctx.producer] },
        io,
      ),
    ];
    for (const result of results)
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "illegal_transition",
          message: expect.stringContaining(
            `${ctx.producer} (produce:${status})`,
          ),
        },
      });
  },
);

test.each(["decision", "human_action"] as const)(
  "invariant 11: %s identifies a non-caller item that cannot pause and returns no partial changes",
  (action) => {
    const ctx = setup();
    const before = JSON.stringify(ctx.state);
    const result =
      action === "decision"
        ? requestDecision(
            ctx.state,
            ctx.coder,
            {
              ...decisionParams(ctx),
              affected_work_items: [ctx.producer, ctx.verifier],
            },
            io,
          )
        : requestHumanAction(
            ctx.state,
            ctx.coder,
            {
              ...actionParams(ctx, ctx.producer),
              blocked_work_items: [ctx.producer, ctx.verifier],
            },
            io,
          );
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "illegal_transition",
        message: expect.stringContaining(`${ctx.verifier} (verify:todo)`),
      },
    });
    expect(result).not.toHaveProperty("value");
    expect(JSON.stringify(ctx.state)).toBe(before);
  },
);

test.each(actions)(
  "invariant 11: %s cannot activate an exhausted verifier from a legacy ready snapshot",
  async (action) => {
    const ctx = setup(1);
    const first = await deliver(ctx, ctx.state);
    let state = apply(ctx.state, first);
    state = apply(state, review(ctx, state, first.data));
    state = {
      ...state,
      reviews: state.reviews.map((r) => ({ ...r, verdict: "reject" as const })),
      work_items: state.work_items.map((w) =>
        w.id === ctx.verifier
          ? ({
              ...w,
              status: value(
                transition("verify", "passed", "target_redelivered"),
              ),
            } as typeof w)
          : w,
      ),
    };
    expect(pause(ctx, state, action, ctx.reviewer, ctx.verifier)).toMatchObject(
      {
        ok: false,
        error: {
          code: "illegal_transition",
          message: expect.stringContaining(
            `Review round limit has been reached for ${ctx.verifier}`,
          ),
        },
      },
    );
  },
);

// ------------------------------------------------- M5.S S6: assign and start

test("M5.S S6: canStartWork reads the real state after createCard + assign", () => {
  const seed = fixture();
  let state: CommandState = {
    ...seed,
    cards: [],
    work_items: [],
    assignments: seed.assignments.filter((a) => a.scope === "standing"),
    runs: [],
  };
  const created = value(
    createCard(
      state,
      office,
      {
        title: "Assign starts an Agent",
        goal: "Ship",
        acceptance_criteria: ["Pass"],
        source: { kind: "quote", text: "Build" },
        repo: "example/repo",
        base_branch: "main",
      },
      io,
    ),
  );
  state = apply(state, created);
  const producer = present(
    state.work_items.find((w) => w.template_key === "development"),
  );
  const verifier = present(
    state.work_items.find((w) => w.template_key === "code_review"),
  );

  // Assigned but not started: nothing has run, so nothing is delivered yet.
  state = apply(
    state,
    value(
      assign(
        state,
        office,
        { work_item_id: producer.id, role_id: producer.role_id },
        io,
      ),
    ),
  );
  expect(state.work_items.find((item) => item.id === producer.id)?.status).toBe(
    "todo",
  );

  // The produce item has no dependencies, so its Assignment may start now.
  expect(
    canStartWork({
      item: present(state.work_items.find((item) => item.id === producer.id)),
      work_items: state.work_items,
    }),
  ).toBe(true);

  // The verifier is assigned too, but its target has no delivery: it waits and
  // is woken by the delivery bell instead of the assign bell.
  state = apply(
    state,
    value(
      assign(
        state,
        office,
        { work_item_id: verifier.id, role_id: verifier.role_id },
        io,
      ),
    ),
  );
  const waitingVerifier = present(
    state.work_items.find((item) => item.id === verifier.id),
  );
  expect(waitingVerifier.status).toBe("todo");
  expect(
    canStartWork({ item: waitingVerifier, work_items: state.work_items }),
  ).toBe(false);

  // Once the target is delivered the verifier moves to ready and can start.
  const delivered = value(transition("verify", "todo", "target_delivered"));
  const readyVerifier = { ...waitingVerifier, status: delivered } as WorkItem;
  expect(
    canStartWork({
      item: readyVerifier,
      work_items: [...state.work_items],
    }),
  ).toBe(true);
});

test("M5.S S6: a produce work item waits for an unfinished dependency", () => {
  const seed = fixture();
  let state: CommandState = {
    ...seed,
    cards: [],
    work_items: [],
    assignments: seed.assignments.filter((a) => a.scope === "standing"),
    runs: [],
  };
  const created = value(
    createCard(
      state,
      office,
      {
        title: "Dependencies first",
        goal: "Ship",
        acceptance_criteria: ["Pass"],
        source: { kind: "quote", text: "Build" },
        repo: "example/repo",
        base_branch: "main",
      },
      io,
    ),
  );
  state = apply(state, created);
  const dependency = present(
    state.work_items.find((w) => w.template_key === "development"),
  );
  const dependent = value(
    createWorkItem(
      state,
      office,
      {
        card_id: created.data.id,
        title: "After the development",
        kind: "produce",
        role_id: "coder",
        required: false,
        completion_criteria: ["Pass"],
        depends_on: [dependency.id],
      },
      io,
    ),
  );
  state = apply(state, dependent);
  const assigned = present(
    state.work_items.find((item) => item.id === dependent.data.id),
  );
  expect(assigned.status).toBe("todo");
  expect(canStartWork({ item: assigned, work_items: state.work_items })).toBe(
    false,
  );

  // The dependency succeeded: the same item may now start.
  expect(
    canStartWork({
      item: assigned,
      work_items: state.work_items.map((item) =>
        item.id === dependency.id
          ? ({ ...item, status: "accepted" } as WorkItem)
          : item,
      ),
    }),
  ).toBe(true);
});

test.each([false, true])(
  "Flow Lite: passing reviews leave budget for redelivery (finished=%s)",
  async (finished) => {
    const ctx = setup(1);
    const first = await deliver(ctx, ctx.state);
    let state = apply(ctx.state, first);
    state = apply(state, review(ctx, state, first.data));
    if (finished) {
      const run = present(
        state.runs.find(
          (r) => r.assignment_id === item(state, ctx.verifier).assignment_id,
        ),
      );
      state = apply(
        state,
        value(
          finishRun(
            state,
            ctx.reviewer,
            { run_id: run.id, outcome: "completed", summary: "Passed" },
            io,
          ),
        ),
      );
    }
    const next = await deliver(ctx, state, "b".repeat(40));
    state = apply(state, next);
    expect(item(state, ctx.verifier)).toMatchObject({
      status: "ready",
      max_review_rounds: 1,
    });
    expect(state.decisions).toEqual([]);
    expect(next.events.map((e) => e.type)).toEqual(["delivery_submitted"]);
  },
);
