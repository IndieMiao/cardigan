import { beforeEach, expect, test } from "vitest";
import {
  type CommandState,
  completeHumanAction,
  type DecisionId,
  finishRun,
  listNeedsYou,
  prepareDelivery,
  recordDecision,
  reportBlocker,
  requestDecision,
  requestHumanAction,
  reviewLimitAttention,
  submitDelivery,
  submitReview,
  toolNames,
  updateWorkItem,
} from "../index.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  ports,
  subject,
  value,
} from "./test-fixtures.js";

const office = actor(4, "pm");
const ops = {
  ...office,
  allowed_tools: toolNames.filter((t) => t !== "record_decision"),
};
const producer = id("work_item", 1);
const reviewer = id("work_item", 2);
const choice = {
  card_id: id("card", 1),
  category: "general" as const,
  kind: "choose" as const,
  question: "Choose",
  context: "A choice is needed",
  decider: "human" as const,
  options: [{ key: "go", description: "Continue", impact: "Unblocks work" }],
  recommended: "go",
  affected_cards: [],
  affected_work_items: [producer],
  blocking: true,
};
const humanRequest = {
  card_id: id("card", 1),
  instructions: "Connect device",
  why_human: "Physical access",
  expected_return: "Connected",
  blocked_work_items: [producer],
};
let io = ports();
beforeEach(() => {
  io = ports();
});
const resolve = (state: CommandState, decision_id: DecisionId, option = "go") =>
  value(
    recordDecision(
      state,
      office,
      { decision_id, option, rationale: "Confirmed", raw_quote: option },
      io,
    ),
  );
const activate = (state: CommandState): CommandState => ({
  ...state,
  runs: state.runs.map((r) =>
    r.status === "queued" ? { ...r, status: "running" } : r,
  ),
});
async function deliver(state: CommandState, sha = subject.value) {
  const p = {
    work_item_id: producer,
    kind: "code" as const,
    summary: "Ready",
    subject: { ...subject, value: sha },
    requested_verifiers: [reviewer],
  };
  const receipt = value(
    await prepareDelivery(state, actor(), p, {
      verify: async () => ({ ok: true, value: [] }),
    }),
  );
  return value(submitDelivery(state, actor(), p, receipt, io));
}
async function exhausted(verdict: "reject" | "conditional" = "conditional") {
  const initial = fixture();
  let state: CommandState = {
    ...initial,
    work_items: initial.work_items.map((w) =>
      w.kind === "verify" ? { ...w, max_review_rounds: 1 } : w,
    ),
  };
  const product = await deliver(state);
  state = apply(state, product);
  state = apply(
    state,
    value(
      submitReview(
        state,
        actor(2, "reviewer"),
        {
          delivery_id: product.data.id,
          target_sha: subject.value,
          kind: "code",
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
    ),
  );
  const decision = state.decisions[0];
  if (!decision) throw new Error("Missing review-limit decision");
  return { state, product: product.data, decision };
}

test.each([false, true])(
  "invariants 5, 8, 11: PM resumes a role blocker after the Run ended=%s and delivery can proceed",
  async (ended) => {
    let state = fixture();
    state = apply(
      state,
      value(
        reportBlocker(
          state,
          actor(),
          { work_item_id: producer, reason: "Need input", needs: "role" },
          io,
        ),
      ),
    );
    const params = { work_item_id: producer, status: "in_progress" as const };
    expect(updateWorkItem(state, actor(), params, io)).toMatchObject({
      ok: false,
      error: { code: "forbidden_tool" },
    });
    if (ended)
      state = apply(
        state,
        value(
          finishRun(
            state,
            actor(),
            { run_id: id("run", 1), outcome: "blocked", summary: "Waiting" },
            io,
          ),
        ),
      );
    const result = value(updateWorkItem(state, office, params, io));
    state = apply(state, result);
    expect(result.data.status).toBe("in_progress");
    expect(result.events[0]?.payload).toMatchObject({
      resume_work_items: [producer],
    });
    expect(state.runs.filter((r) => r.status === "queued")).toHaveLength(
      ended ? 1 : 0,
    );
    if (ended) {
      expect(state.runs.find((r) => r.id === id("run", 1))).toMatchObject({
        status: "completed",
        outcome: "blocked",
      });
      expect(state.runs.find((r) => r.status === "queued")).toMatchObject({
        assignment_id: id("assignment", 1),
        kind: "followup",
        trigger_event_id: result.events[0]?.id,
      });
    }
    expect((await deliver(activate(state))).data.status).toBe("submitted");
  },
);

test.each(["decision", "provisional", "human_action"] as const)(
  "invariant 11: PM can confirm a reported blocker while an outstanding %s still pauses work",
  (blocker) => {
    let state = fixture();
    state = apply(
      state,
      value(
        reportBlocker(
          state,
          actor(),
          { work_item_id: producer, reason: "Waiting", needs: "role" },
          io,
        ),
      ),
    );
    if (blocker === "human_action")
      state = apply(
        state,
        value(requestHumanAction(state, actor(), humanRequest, io)),
      );
    else {
      const pending = value(
        requestDecision(fixture(), actor(), choice, io),
      ).data;
      state = {
        ...state,
        decisions: [
          {
            ...pending,
            status: blocker === "provisional" ? "provisional" : "open",
          },
        ],
      };
    }
    const before = JSON.stringify(state);
    const confirmed = value(
      updateWorkItem(
        state,
        office,
        { work_item_id: producer, status: "in_progress" },
        io,
      ),
    );
    const after = apply(state, confirmed);
    expect(confirmed.data.status).toBe("blocked");
    expect(confirmed.data.reported_blocker).toBeUndefined();
    expect(confirmed.events[0]?.payload).toMatchObject({
      reported_blocker_cleared: true,
      resume_work_items: [],
    });
    expect(after.runs).toEqual(state.runs);
    expect(after.decisions).toEqual(state.decisions);
    expect(after.human_actions).toEqual(state.human_actions);
    expect(JSON.stringify(state)).toBe(before);
  },
);

test.each(
  [[], [reviewer], [producer, producer]].map((affected_work_items) => ({
    affected_work_items,
  })),
)(
  "invariants 5, 10, 12: blocking decision targets %j also include the caller exactly once",
  ({ affected_work_items }) => {
    const initial = fixture();
    let state: CommandState = {
      ...initial,
      work_items: initial.work_items.map((w) => ({
        ...w,
        status: "in_progress",
      })),
    };
    const requested = value(
      requestDecision(state, actor(), { ...choice, affected_work_items }, io),
    );
    expect(
      requested.data.affected_work_items.filter((id) => id === producer),
    ).toHaveLength(1);
    state = apply(state, requested);
    expect(state.work_items.find((w) => w.id === producer)?.status).toBe(
      "waiting_decision",
    );
    expect(state.runs.find((r) => r.id === id("run", 1))).toMatchObject({
      status: "completed",
      outcome: "blocked",
    });
    state = apply(state, resolve(state, requested.data.id));
    expect(state.work_items.find((w) => w.id === producer)?.status).toBe(
      "in_progress",
    );
    expect(
      state.runs.filter(
        (r) => r.assignment_id === id("assignment", 1) && r.status === "queued",
      ),
    ).toHaveLength(1);
  },
);

test("invariant 10: a nonblocking decision does not implicitly pause the requesting work item", () => {
  const state = fixture();
  const result = value(
    requestDecision(
      state,
      actor(),
      { ...choice, affected_work_items: [], blocking: false },
      io,
    ),
  );
  expect(result.data.affected_work_items).toEqual([]);
  expect(apply(state, result).runs).toEqual(state.runs);
});

test("invariants 10, 11: review-limit pause remains pending even after Ops raises the limit, then can be confirmed", async () => {
  let { state, decision } = await exhausted();
  expect(decision.trigger).toBe("review_limit");
  const paused = resolve(state, decision.id, "pause");
  state = apply(state, paused);
  expect(paused.data).toMatchObject({
    status: "provisional",
    resolution: { option: "pause", raw_quote: "pause" },
  });
  expect(paused.events[0]?.payload).toMatchObject({ resume_work_items: [] });
  expect(state.work_items.find((w) => w.id === reviewer)?.status).toBe(
    "waiting_decision",
  );
  expect(state.runs.some((r) => r.status === "queued")).toBe(false);
  state = apply(
    state,
    value(
      updateWorkItem(
        state,
        ops,
        { work_item_id: reviewer, max_review_rounds: 2 },
        io,
      ),
    ),
  );
  expect(state.work_items.find((w) => w.id === reviewer)?.status).toBe(
    "waiting_decision",
  );
  expect(state.runs.some((r) => r.status === "queued")).toBe(false);
  state = apply(state, resolve(state, decision.id, "raise_limit"));
  expect(state.work_items.find((w) => w.id === reviewer)?.status).toBe("ready");
  expect(state.runs.filter((r) => r.status === "queued")).toHaveLength(1);
});

test.each(["reject", "conditional"] as const)(
  "invariants 5, 10, 11, 12: a %s at the limit atomically raises the budget and resumes via recordDecision",
  async (verdict) => {
    let { state, product, decision } = await exhausted(verdict);
    const recorded = resolve(state, decision.id, "raise_limit");
    state = apply(state, recorded);
    expect(recorded.events[0]?.payload).toMatchObject({
      resume_work_items: [],
    });
    expect(state.work_items.find((w) => w.id === reviewer)).toMatchObject({
      status: "ready",
      max_review_rounds: 2,
    });
    expect(recorded.events.at(-1)?.payload).toMatchObject({
      resume_work_items: [reviewer],
    });
    expect(state.runs.find((r) => r.id === id("run", 2))).toMatchObject({
      status: "completed",
      outcome: "blocked",
      review_limit_changes: [{ max_review_rounds: 2 }],
    });
    expect(state.runs.find((r) => r.status === "queued")).toMatchObject({
      assignment_id: id("assignment", 2),
      kind: "decision_resumed",
      trigger_event_id: recorded.events.at(-1)?.id,
      role_version: 1,
      model: "fixture-model",
      agent_cli_version: "1.0",
    });
    state = apply(
      state,
      value(
        updateWorkItem(
          state,
          ops,
          { work_item_id: reviewer, max_review_rounds: 2 },
          io,
        ),
      ),
    );
    expect(state.runs.filter((r) => r.status === "queued")).toHaveLength(1);
    if (verdict === "reject") {
      const redelivery = await deliver(state, "b".repeat(40));
      state = apply(state, redelivery);
      product = redelivery.data;
    }
    const passed = value(
      submitReview(
        activate(state),
        actor(2, "reviewer"),
        {
          delivery_id: product.id,
          target_sha: product.subject.value,
          kind: "code",
          issues: [],
        },
        io,
      ),
    );
    expect(passed.data.verdict).toBe("pass");
  },
);

test.each(["before", "after"] as const)(
  "invariants 10, 11: raising the budget %s recording the limit decision cannot bypass another blocking decision",
  async (order) => {
    let { state, decision } = await exhausted();
    const other = value(
      requestDecision(
        state,
        office,
        { ...choice, affected_work_items: [reviewer] },
        io,
      ),
    );
    state = apply(state, other);
    if (order === "after")
      state = apply(state, resolve(state, decision.id, "raise_limit"));
    state = apply(
      state,
      value(
        updateWorkItem(
          state,
          ops,
          { work_item_id: reviewer, max_review_rounds: 2 },
          io,
        ),
      ),
    );
    if (order === "before")
      state = apply(state, resolve(state, decision.id, "raise_limit"));
    expect(state.work_items.find((w) => w.id === reviewer)?.status).toBe(
      "waiting_decision",
    );
    expect(state.runs.some((r) => r.status === "queued")).toBe(false);
    state = apply(state, resolve(state, other.data.id));
    expect(state.work_items.find((w) => w.id === reviewer)?.status).toBe(
      "ready",
    );
    expect(state.runs.filter((r) => r.status === "queued")).toHaveLength(1);
  },
);

test("invariant 11: generic choices named pause cannot impersonate a control-plane review-limit decision", () => {
  const requested = value(
    requestDecision(
      fixture(),
      actor(),
      {
        ...choice,
        options: [{ key: "pause", description: "Choice", impact: "Recorded" }],
        recommended: "pause",
      },
      io,
    ),
  );
  expect(requested.data.trigger).toBeUndefined();
  const result = resolve(
    apply(fixture(), requested),
    requested.data.id,
    "pause",
  );
  expect(result.data.status).toBe("resolved");
  expect(result.events[0]?.payload).toMatchObject({
    resume_work_items: [producer],
  });
});

test("invariant 11: human-action completion reports only items actually resumed", () => {
  const initial = fixture();
  let state: CommandState = {
    ...initial,
    work_items: initial.work_items.map((w) => ({
      ...w,
      status: "in_progress",
    })),
  };
  const first = value(
    requestHumanAction(
      state,
      actor(),
      { ...humanRequest, blocked_work_items: [producer, reviewer] },
      io,
    ),
  );
  state = apply(state, first);
  const second = value(
    requestHumanAction(
      state,
      actor(),
      { ...humanRequest, blocked_work_items: [reviewer] },
      io,
    ),
  );
  state = apply(state, second);
  const result = value(
    completeHumanAction(
      state,
      human,
      { human_action_id: first.data.id, text: "Done" },
      io,
    ),
  );
  expect(result.events[0]?.payload).toMatchObject({
    resume_work_items: [producer],
  });
  state = apply(state, result);
  expect(state.work_items.find((w) => w.id === reviewer)?.status).toBe(
    "blocked",
  );
  const last = value(
    completeHumanAction(
      state,
      human,
      { human_action_id: second.data.id, text: "Done" },
      io,
    ),
  );
  expect(last.events[0]?.payload).toMatchObject({
    resume_work_items: [reviewer],
  });
});

test("invariants 10, 11: a human action also gates review resumption and its completion queues exactly one Run", async () => {
  let { state, decision } = await exhausted();
  const initial = fixture();
  const action = value(
    requestHumanAction(
      {
        ...initial,
        work_items: initial.work_items.map((w) => ({
          ...w,
          status: "in_progress",
        })),
      },
      office,
      { ...humanRequest, blocked_work_items: [reviewer] },
      io,
    ),
  ).data;
  state = { ...state, human_actions: [action] };
  state = apply(state, resolve(state, decision.id, "raise_limit"));
  state = apply(
    state,
    value(
      updateWorkItem(
        state,
        ops,
        { work_item_id: reviewer, max_review_rounds: 2 },
        io,
      ),
    ),
  );
  expect(state.work_items.find((w) => w.id === reviewer)?.status).toBe(
    "waiting_decision",
  );
  expect(state.runs.some((r) => r.status === "queued")).toBe(false);
  const result = value(
    completeHumanAction(
      state,
      human,
      { human_action_id: action.id, text: "Done" },
      io,
    ),
  );
  state = apply(state, result);
  expect(result.events[0]?.payload).toMatchObject({
    resume_work_items: [reviewer],
  });
  expect(state.work_items.find((w) => w.id === reviewer)?.status).toBe("ready");
  expect(state.runs.filter((r) => r.status === "queued")).toHaveLength(1);
  expect(state.runs.find((r) => r.status === "queued")).toMatchObject({
    kind: "decision_resumed",
    trigger_event_id: result.events[0]?.id,
  });
});

test.each([human, office])(
  "invariants 10, 11: pause then raise_limit resumes atomically for $kind",
  async (caller) => {
    let { state, decision } = await exhausted();
    state = apply(state, resolve(state, decision.id, "pause"));
    const params = {
      decision_id: decision.id,
      option: "raise_limit",
      rationale: "继续审核",
      raw_quote: "再加一轮",
    };
    const effect = value(recordDecision(state, caller, params, io));
    state = apply(state, effect);
    expect(effect.events.map((e) => e.type)).toEqual([
      "work_item_updated",
      "decision_resolved",
    ]);
    expect(state.work_items.find((w) => w.id === reviewer)).toMatchObject({
      status: "ready",
      max_review_rounds: 2,
    });
    expect(state.runs.filter((r) => r.status === "queued")).toHaveLength(1);
    expect(effect.data.resolution).toMatchObject({
      raw_quote: "再加一轮",
      via: caller.kind === "human" ? "needs_you" : "pm_office_chat",
    });
    expect(recordDecision(state, caller, params, io).ok).toBe(false);
  },
);

test("review-limit attention starts strictly after ten minutes and clears on recovery", async () => {
  const { state: pending, decision } = await exhausted();
  // Reproduce the historical bug: resolution persisted without any budget or resume effects.
  const resolution = resolve(pending, decision.id, "raise_limit").data;
  const state = { ...pending, decisions: [resolution] };
  const at = Date.parse(resolution.resolution?.at ?? "");
  const atTime = (ms: number) => new Date(at + ms).toISOString();
  for (const ms of [-1, 0, 599999, 600000])
    expect(reviewLimitAttention(state, atTime(ms))).toEqual([]);
  const findings = reviewLimitAttention(state, atTime(600001));
  expect(findings).toEqual([
    expect.objectContaining({
      kind: "review_limit_not_resumed",
      decision_id: decision.id,
      work_item_id: reviewer,
      waited_ms: 600001,
    }),
  ]);
  expect(
    value(listNeedsYou(state, human, { now: () => atTime(600001) })).data
      .attention,
  ).toEqual(findings);
  expect(reviewLimitAttention(pending, atTime(600001))).toEqual([]);
  const paused = apply(pending, resolve(pending, decision.id, "pause"));
  expect(reviewLimitAttention(paused, atTime(600001))).toEqual([]);
  const repaired = apply(
    state,
    value(
      updateWorkItem(
        state,
        human,
        { work_item_id: reviewer, max_review_rounds: 2 },
        io,
      ),
    ),
  );
  expect(reviewLimitAttention(repaired, atTime(600001))).toEqual([]);
  // A later unrelated wait must not revive the old alarm.
  const waitingAgain: CommandState = {
    ...repaired,
    work_items: repaired.work_items.map((w) =>
      w.id === reviewer ? { ...w, status: "waiting_decision" } : w,
    ),
  };
  expect(reviewLimitAttention(waitingAgain, atTime(600001))).toEqual([]);
  const newerId = io.ids.next(state.project_id, "decision");
  const newer = { ...decision, id: newerId, key: newerId };
  expect(
    reviewLimitAttention(
      { ...state, decisions: [resolution, newer] },
      atTime(600001),
    ),
  ).toEqual([]);
  const { trigger: _trigger, ...ordinary } = resolution;
  expect(
    reviewLimitAttention({ ...state, decisions: [ordinary] }, atTime(600001)),
  ).toEqual([]);
});

test.each(["closed", "overflow"])(
  "invariant 11: invalid review-limit updates (%s) leave the decision and budget unchanged",
  async (failure) => {
    const { state: initial, decision } = await exhausted();
    const state: CommandState = {
      ...initial,
      cards: initial.cards.map((c) =>
        failure === "closed" ? { ...c, status: "cancelled" } : c,
      ),
      work_items: initial.work_items.map((w) =>
        failure === "overflow" && w.id === reviewer && w.kind === "verify"
          ? { ...w, max_review_rounds: Number.MAX_SAFE_INTEGER }
          : w,
      ),
    };
    const before = JSON.stringify(state);
    expect(
      recordDecision(
        state,
        human,
        {
          decision_id: decision.id,
          option: "raise_limit",
          rationale: "Continue",
          raw_quote: "Continue",
        },
        io,
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: failure === "closed" ? "illegal_transition" : "validation_failed",
      },
    });
    expect(JSON.stringify(state)).toBe(before);
  },
);
