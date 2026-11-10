import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  listNeedsYou,
  pauseStandingAssignment,
  recordDecision,
  releaseAssignment,
  requestHumanAction,
  standingTools,
  submitReview,
  updateWorkItem,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { assignment, human, id, role, value } from "./test-fixtures.js";

async function limited(
  mode: "ops" | "office" = "ops",
  status: Assignment["status"] = "active",
) {
  const f = mergeFixture("auto", 1);
  const { work_item_id: _work, ...base } = assignment(4, "pm");
  const ops: Assignment = {
    ...base,
    scope: "standing",
    standing_mode: mode,
    status,
  };
  f.commit({
    ok: true,
    value: {
      data: ops,
      changes: [{ collection: "assignments", entity: ops }],
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
  const actor: Actor = {
    kind: "assignment",
    project_id: f.state.project_id,
    assignment_id: ops.id,
    ...role("pm"),
    allowed_tools: standingTools(role("pm").allowed_tools, mode),
  };
  const target = await f.deliver();
  f.start(f.reviewer);
  f.commit(
    submitReview(
      f.state,
      f.actor(f.reviewer),
      {
        delivery_id: target.id,
        target_sha: target.subject.value,
        kind: "code",
        issues: [],
        recheck_required: true,
      },
      f.io,
    ),
  );
  const decision = f.state.decisions.at(-1);
  if (!decision) throw new Error("Missing review limit");
  const work = f.state.work_items.find((w) => w.id === f.reviewer.work_item_id);
  if (!work) throw new Error("Missing reviewer");
  const resolve = (
    option: "raise_limit" | "pause" | "escalate",
    rationale = "核对后继续处理",
  ) =>
    updateWorkItem(
      f.state,
      actor,
      {
        work_item_id: work.id,
        review_limit_decision: { decision_id: decision.id, option, rationale },
      },
      f.io,
    );
  return { f, ops, actor, decision, work, resolve };
}

test.each([
  ["pause", "open"],
  ["pause", "provisional"],
  ["release", "open"],
  ["release", "provisional"],
] as const)(
  "losing the last PM Ops via %s hands its %s limit to a human who can resume review",
  async (operation, status) => {
    const { f, ops, decision, work, resolve } = await limited();
    if (status === "provisional") f.commit(resolve("pause"));
    const deactivate = () => {
      if (operation === "pause")
        f.commit(
          pauseStandingAssignment(
            f.state,
            human,
            { assignment_id: ops.id },
            f.io,
          ),
        );
      else
        f.commit(
          releaseAssignment(f.state, human, { assignment_id: ops.id }, f.io),
        );
    };
    deactivate();
    expect(value(listNeedsYou(f.state, human)).data.decisions).toEqual([
      expect.objectContaining({
        id: decision.id,
        decider: "human",
        status,
        context: expect.stringContaining("项目已无活跃后台"),
      }),
    ]);
    expect(f.state.events.at(-1)).toMatchObject({
      type: "decision_requested",
      actor: human,
      payload: {
        decision_id: decision.id,
        previous_decider: "role:pm",
        assignment_id: ops.id,
      },
    });
    expect(f.state.work_items.find((w) => w.id === work.id)).toMatchObject({
      status: "waiting_decision",
      max_review_rounds: 1,
    });
    expect(resolve("raise_limit").ok).toBe(false);
    const before = f.state;
    deactivate();
    expect(f.state).toEqual(before);
    f.commit(
      updateWorkItem(
        f.state,
        human,
        { work_item_id: work.id, max_review_rounds: 2 },
        f.io,
      ),
    );
    f.commit(
      recordDecision(
        f.state,
        human,
        {
          decision_id: decision.id,
          option: "raise_limit",
          rationale: "确认继续审核",
          raw_quote: "确认继续审核",
        },
        f.io,
      ),
    );
    expect(f.state.work_items.find((w) => w.id === work.id)).toMatchObject({
      status: "ready",
      max_review_rounds: 2,
    });
    expect(f.state.runs.filter((r) => r.status === "queued")).toHaveLength(1);
  },
);

test("another active PM Ops keeps delegated limits off Needs You until the last one leaves", async () => {
  const { f, ops, decision } = await limited();
  const second: Assignment = { ...ops, id: id("assignment", 5) };
  f.commit({
    ok: true,
    value: {
      data: second,
      changes: [{ collection: "assignments", entity: second }],
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
  f.commit(
    pauseStandingAssignment(f.state, human, { assignment_id: ops.id }, f.io),
  );
  expect(f.state.decisions.find((q) => q.id === decision.id)?.decider).toBe(
    "role:pm",
  );
  expect(value(listNeedsYou(f.state, human)).data.decisions).toEqual([]);
  f.commit(
    releaseAssignment(f.state, human, { assignment_id: second.id }, f.io),
  );
  expect(value(listNeedsYou(f.state, human)).data.decisions).toEqual([
    expect.objectContaining({ id: decision.id }),
  ]);
});

test.each([false, true])(
  "PM Ops raises a delegated limit atomically and resumes once (paused=%s)",
  async (paused) => {
    const { f, actor, decision, work, resolve } = await limited();
    expect(
      actor.kind === "assignment" &&
        actor.allowed_tools.includes("record_decision"),
    ).toBe(false);
    expect(decision.decider).toBe("role:pm");
    expect(value(listNeedsYou(f.state, human)).data.decisions).toEqual([]);
    if (paused) {
      f.commit(resolve("pause", "先核对争议"));
      expect(f.state.decisions.at(-1)).toMatchObject({
        status: "provisional",
        resolution: { rationale: "先核对争议", via: "delegated" },
      });
      expect(f.state.work_items.find((w) => w.id === work.id)).toMatchObject({
        status: "waiting_decision",
        max_review_rounds: 1,
      });
      expect(value(listNeedsYou(f.state, human)).data.decisions).toEqual([]);
    }
    expect(f.commit(resolve("raise_limit"))).toMatchObject({
      status: "ready",
      max_review_rounds: 2,
    });
    expect(f.state.decisions.at(-1)).toMatchObject({
      status: "resolved",
      resolution: { resolved_by: "assignment:A-4", via: "delegated" },
    });
    expect(
      f.state.runs.find((r) => r.review_limit_changes?.length)
        ?.review_limit_changes,
    ).toEqual([
      expect.objectContaining({
        max_review_rounds: 2,
        actor: "assignment:A-4",
      }),
    ]);
    expect(f.state.runs.filter((r) => r.status === "queued")).toHaveLength(1);
    expect(resolve("raise_limit").ok).toBe(false);
    expect(f.state.work_items.find((w) => w.id === work.id)).toMatchObject({
      max_review_rounds: 2,
    });
  },
);

test.each(["open", "provisional"])(
  "PM Ops can escalate the same %s decision to the human with its reason",
  async (status) => {
    const { f, decision, work, resolve } = await limited();
    if (status === "provisional") f.commit(resolve("pause"));
    f.commit(resolve("escalate", "需求存在疑问，需要确认预期结果"));
    expect(f.state.decisions).toHaveLength(1);
    expect(value(listNeedsYou(f.state, human)).data.decisions).toEqual([
      expect.objectContaining({
        id: decision.id,
        decider: "human",
        status,
        context: expect.stringContaining("需求存在疑问"),
      }),
    ]);
    expect(f.state.work_items.find((w) => w.id === work.id)).toMatchObject({
      status: "waiting_decision",
      max_review_rounds: 1,
    });
    expect(resolve("raise_limit").ok).toBe(false);
    expect(f.state.events.at(-1)).toMatchObject({
      type: "decision_requested",
      payload: { decision_id: decision.id, previous_decider: "role:pm" },
    });
  },
);

test.each([
  ["office", "active"],
  ["ops", "suspended"],
  ["ops", "released"],
] as const)(
  "without active PM Ops, review limits fall back to the human (%s/%s)",
  async (mode, status) => {
    const { f, decision } = await limited(mode, status);
    expect(decision.decider).toBe("human");
    expect(value(listNeedsYou(f.state, human)).data.decisions).toEqual([
      expect.objectContaining({ id: decision.id }),
    ]);
  },
);

test("delegated review-limit decisions require a reason, exact scope and PM Ops identity", async () => {
  const { f, actor, decision, work, resolve } = await limited();
  expect(resolve("raise_limit", " ")).toMatchObject({
    ok: false,
    error: { code: "validation_failed" },
  });
  for (const caller of [human, f.actor(f.pm), f.actor(f.coder)])
    expect(
      updateWorkItem(
        f.state,
        caller,
        {
          work_item_id: work.id,
          review_limit_decision: {
            decision_id: decision.id,
            option: "raise_limit",
            rationale: "继续",
          },
        },
        f.io,
      ).ok,
    ).toBe(false);
  expect(
    updateWorkItem(
      f.state,
      actor,
      {
        work_item_id: work.id,
        max_review_rounds: 9,
        review_limit_decision: {
          decision_id: decision.id,
          option: "raise_limit",
          rationale: "继续",
        },
      },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    recordDecision(
      f.state,
      human,
      {
        decision_id: decision.id,
        option: "raise_limit",
        rationale: "继续",
        raw_quote: "继续",
      },
      f.io,
    ).ok,
  ).toBe(false);
  expect(f.state.work_items.find((w) => w.id === work.id)).toMatchObject({
    max_review_rounds: 1,
  });
});

test("raising a delegated review limit does not bypass another blocker", async () => {
  const { f, work, resolve } = await limited();
  f.commit(
    requestHumanAction(
      f.state,
      f.actor(f.coder),
      {
        card_id: f.card.id,
        instructions: "确认设备",
        why_human: "需要现场操作",
        expected_return: "确认结果",
        blocked_work_items: [work.id],
      },
      f.io,
    ),
  );
  expect(f.commit(resolve("raise_limit"))).toMatchObject({
    status: "waiting_decision",
    max_review_rounds: 2,
  });
  expect(f.state.runs.filter((r) => r.status === "queued")).toEqual([]);
});
