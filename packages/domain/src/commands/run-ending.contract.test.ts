import { expect, test } from "vitest";
import {
  finishRun,
  type RequestDecisionParams,
  requestDecision,
} from "../index.js";
import {
  actor,
  apply,
  fixture,
  id,
  now,
  ports,
  run,
  value,
} from "./test-fixtures.js";

const choice: RequestDecisionParams = {
  category: "general",
  kind: "choose",
  question: "Choose the next step",
  context: "Work needs a decision",
  options: [{ key: "go", description: "Continue", impact: "Resume work" }],
  recommended: "go",
  affected_cards: [],
  affected_work_items: [],
  blocking: true,
  decider: "human",
  plain_summary: {
    changed: "等待确认后续安排",
    impact: "暂停本次工作",
    risk: "无",
  },
};

function standingFixture() {
  const state = fixture();
  return {
    ...state,
    assignments: state.assignments.map((a) =>
      a.id === id("assignment", 4)
        ? { ...a, runtime_state: "running" as const }
        : a,
    ),
    runs: [...state.runs, run(4)],
  };
}

test("C-255 invariants 5, 10: a standing blocking decision records its implicit ending in the project stream", () => {
  const initial = standingFixture();
  const effect = value(
    requestDecision(initial, actor(4, "pm"), choice, ports()),
  );
  const state = apply(initial, effect);
  const ended = state.runs.find((r) => r.id === id("run", 4));
  expect(ended).toMatchObject({
    status: "completed",
    outcome: "blocked",
    summary: choice.question,
    finished_at: now,
  });
  expect(
    state.assignments.find((a) => a.id === id("assignment", 4))?.runtime_state,
  ).toBe("idle");
  const events = effect.events.filter((e) => e.type === "run_finished");
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    actor: actor(4, "pm"),
    created_at: now,
    payload: {
      run_id: id("run", 4),
      assignment_id: id("assignment", 4),
      outcome: "blocked",
      summary: choice.question,
      finished_by: "system",
      reason: "blocking_decision",
      decision_id: effect.data.id,
      body: expect.stringContaining("系统因阻塞拍板"),
    },
  });
  expect(events[0]?.card_id).toBeUndefined();
  expect(state.runs.filter((r) => r.id !== id("run", 4))).toEqual(
    initial.runs.filter((r) => r.id !== id("run", 4)),
  );

  const before = JSON.stringify(state);
  for (let attempt = 0; attempt < 2; attempt++) {
    const late = value(
      finishRun(
        state,
        actor(4, "pm"),
        {
          run_id: id("run", 4),
          outcome: "blocked",
          summary: "Late agent conclusion",
        },
        ports(),
      ),
    );
    expect(late.data).toMatchObject({
      ...ended,
      finish_notice: expect.stringContaining("未另行保存"),
    });
    expect(late.changes).toEqual([]);
    expect(late.events).toEqual([]);
    expect(late.timeline).toEqual([]);
  }
  for (const outcome of ["completed", "failed"] as const) {
    expect(
      finishRun(
        state,
        actor(4, "pm"),
        {
          run_id: id("run", 4),
          outcome,
          summary: "Late agent conclusion",
        },
        ports(),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "illegal_transition",
        message: expect.stringContaining("结果和摘要未保存"),
        details: {
          run_id: id("run", 4),
          outcome: "blocked",
          summary: choice.question,
          finished_at: now,
        },
      },
    });
  }
  expect(JSON.stringify(state)).toBe(before);
});

test("C-255 invariant 10: nonblocking decisions leave standing Runs active without an ending event", () => {
  const initial = standingFixture();
  const effect = value(
    requestDecision(
      initial,
      actor(4, "pm"),
      { ...choice, blocking: false },
      ports(),
    ),
  );
  expect(apply(initial, effect).runs).toEqual(initial.runs);
  expect(effect.events.some((e) => e.type === "run_finished")).toBe(false);
});

test("C-255: affected work-item Runs get card-local system endings and traceable timeline entries", () => {
  const initial = standingFixture();
  const effect = value(
    requestDecision(
      initial,
      actor(4, "pm"),
      {
        ...choice,
        card_id: id("card", 1),
        affected_work_items: [id("work_item", 1)],
      },
      ports(),
    ),
  );
  expect(effect.events.filter((e) => e.type === "run_finished")).toHaveLength(
    2,
  );
  expect(
    effect.events.find((e) => e.type === "run_finished" && e.card_id),
  ).toMatchObject({
    card_id: id("card", 1),
    payload: {
      run_id: id("run", 1),
      finished_by: "system",
      reason: "blocking_decision",
      decision_id: effect.data.id,
    },
  });
  expect(effect.timeline).toContainEqual(
    expect.objectContaining({
      type: "system",
      author: "system",
      card_id: id("card", 1),
      run_id: id("run", 1),
      decision_id: effect.data.id,
      body: expect.stringContaining("系统因阻塞拍板"),
    }),
  );
});

test.each(["completed", "blocked", "failed"] as const)(
  "C-255: explicit %s finish still emits exactly one unchanged event",
  (outcome) => {
    const effect = value(
      finishRun(
        fixture(),
        actor(),
        {
          run_id: id("run", 1),
          outcome,
          summary: "Agent conclusion",
        },
        ports(),
      ),
    );
    expect(effect.events).toHaveLength(1);
    expect(effect.events[0]).toMatchObject({
      type: "run_finished",
      actor: actor(),
      card_id: id("card", 1),
    });
    expect(effect.events[0]?.payload).toEqual({
      run_id: id("run", 1),
      outcome,
      summary: "Agent conclusion",
    });
  },
);
