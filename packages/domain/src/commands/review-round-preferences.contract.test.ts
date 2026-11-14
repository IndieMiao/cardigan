import { expect, test } from "vitest";
import {
  type Actor,
  createWorkItem,
  DEFAULT_INDEPENDENT_REVIEW_MAX_ROUNDS,
  DEFAULT_REVIEW_MAX_ROUNDS,
  independentReviewMaxRounds,
  projectPreferences,
  reviewMaxRounds,
  setProjectPreferences,
  standingTools,
  updateWorkItem,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { fixture, human, ports, role } from "./test-fixtures.js";

// C-253: review limits are project preferences (ordinary 5, independent 3).
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
  const target = f.coder.work_item_id;
  if (!target) throw new Error("Missing producer");
  const verifier = (role_id: string, max?: number) => ({
    card_id: f.card.id,
    title: role_id,
    kind: "verify" as const,
    role_id,
    required: true,
    completion_criteria: ["Verify"],
    target_work_item_id: target,
    ...(max === undefined ? {} : { max_review_rounds: max }),
  });
  return { f, pm, verifier };
}

test("missing preferences fall back to 5 and 3", () => {
  expect(reviewMaxRounds()).toBe(5);
  expect(independentReviewMaxRounds()).toBe(3);
  expect(DEFAULT_REVIEW_MAX_ROUNDS).toBe(5);
  expect(DEFAULT_INDEPENDENT_REVIEW_MAX_ROUNDS).toBe(3);
  const { f } = setup();
  const prefs = projectPreferences(f.state);
  expect(prefs.review_max_rounds).toBeUndefined();
  expect(reviewMaxRounds(prefs)).toBe(5);
  expect(independentReviewMaxRounds(prefs)).toBe(3);
});

test.each([0, 21, 1.5, 20.5, -1, Number.NaN, "5"])(
  "invalid review limit preference %s is rejected",
  (bad) => {
    const { f } = setup();
    for (const key of [
      "review_max_rounds",
      "independent_review_max_rounds",
    ] as const)
      expect(
        setProjectPreferences(f.state, human, { [key]: bad as number }, f.io),
      ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  },
);

test("only the human may change review limit preferences", () => {
  const { f, pm } = setup();
  const coder = f.actor(f.coder);
  for (const caller of [pm, coder])
    for (const input of [
      { review_max_rounds: 6 },
      { independent_review_max_rounds: 4 },
    ]) {
      const result = setProjectPreferences(f.state, caller, input, f.io);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(["unauthorized", "forbidden_tool"]).toContain(result.error.code);
    }
  for (const value of [1, 20])
    expect(
      setProjectPreferences(
        f.state,
        human,
        { review_max_rounds: value, independent_review_max_rounds: value },
        f.io,
      ).ok,
    ).toBe(true);
});

test("a changed preference only applies to verifiers created afterwards", () => {
  const { f, pm, verifier } = setup();
  const before = f.commit(
    createWorkItem(f.state, pm, verifier("reviewer"), f.io),
  );
  const beforeIndependent = f.commit(
    createWorkItem(f.state, pm, verifier("independent_reviewer"), f.io),
  );
  expect(before).toMatchObject({ max_review_rounds: 5 });
  expect(beforeIndependent).toMatchObject({ max_review_rounds: 3 });

  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { review_max_rounds: 7, independent_review_max_rounds: 4 },
      f.io,
    ),
  );
  expect(
    f.state.events
      .filter((e) => e.type === "project_preferences_updated")
      .map((e) => e.payload),
  ).toEqual([
    { old_value: 5, new_value: 7, preference: "review_max_rounds" },
    { old_value: 3, new_value: 4, preference: "independent_review_max_rounds" },
  ]);
  // Setting the same values again is a no-op without new events.
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { review_max_rounds: 7, independent_review_max_rounds: 4 },
      f.io,
    ),
  );
  expect(
    f.state.events.filter((e) => e.type === "project_preferences_updated"),
  ).toHaveLength(2);

  const after = f.commit(
    createWorkItem(f.state, pm, verifier("reviewer"), f.io),
  );
  const afterIndependent = f.commit(
    createWorkItem(f.state, pm, verifier("independent_reviewer"), f.io),
  );
  expect(after).toMatchObject({ max_review_rounds: 7 });
  expect(afterIndependent).toMatchObject({ max_review_rounds: 4 });
  // Existing work items keep the limit recorded at creation.
  const stored = (id: string) => f.state.work_items.find((w) => w.id === id);
  expect(stored(before.id)).toMatchObject({ max_review_rounds: 5 });
  expect(stored(beforeIndependent.id)).toMatchObject({ max_review_rounds: 3 });
});

test("independent review above the preference needs the human; the bound follows the preference", () => {
  const { f, pm, verifier } = setup();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { independent_review_max_rounds: 4 },
      f.io,
    ),
  );
  // Creation: PM may use the preference value but not one more.
  expect(
    f.commit(
      createWorkItem(f.state, pm, verifier("independent_reviewer", 4), f.io),
    ),
  ).toMatchObject({ max_review_rounds: 4 });
  expect(
    createWorkItem(f.state, pm, verifier("independent_reviewer", 5), f.io),
  ).toMatchObject({
    ok: false,
    error: {
      code: "validation_failed",
      message: expect.stringContaining("4 轮"),
    },
  });
  const raised = f.commit(
    createWorkItem(f.state, human, verifier("independent_reviewer", 5), f.io),
  );
  expect(raised).toMatchObject({ max_review_rounds: 5 });

  // Update: PM Ops may relax up to the preference value, the human beyond.
  const item = f.commit(
    createWorkItem(f.state, pm, verifier("independent_reviewer", 3), f.io),
  );
  expect(
    f.commit(
      updateWorkItem(
        f.state,
        pm,
        { work_item_id: item.id, max_review_rounds: 4 },
        f.io,
      ),
    ),
  ).toMatchObject({ max_review_rounds: 4 });
  expect(
    updateWorkItem(
      f.state,
      pm,
      { work_item_id: item.id, max_review_rounds: 5 },
      f.io,
    ),
  ).toMatchObject({
    ok: false,
    error: {
      code: "forbidden_tool",
      message: expect.stringContaining("4 轮"),
    },
  });
  expect(
    f.commit(
      updateWorkItem(
        f.state,
        human,
        { work_item_id: item.id, max_review_rounds: 5 },
        f.io,
      ),
    ),
  ).toMatchObject({ max_review_rounds: 5 });
});

test("ordinary verifiers above the preference still need PM Ops or the human", () => {
  const { f, pm, verifier } = setup();
  f.commit(
    setProjectPreferences(f.state, human, { review_max_rounds: 2 }, f.io),
  );
  expect(
    f.commit(createWorkItem(f.state, pm, verifier("reviewer"), f.io)),
  ).toMatchObject({ max_review_rounds: 2 });
  // PM Ops (standing, no record_decision) may raise; the human may raise.
  expect(
    f.commit(createWorkItem(f.state, pm, verifier("reviewer", 3), f.io)),
  ).toMatchObject({ max_review_rounds: 3 });
  const office: Actor = {
    ...pm,
    allowed_tools: [
      ...(pm.kind === "assignment" ? pm.allowed_tools : []),
      "record_decision",
    ],
  };
  expect(
    createWorkItem(f.state, office, verifier("reviewer", 3), f.io),
  ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
  expect(
    createWorkItem(f.state, office, verifier("reviewer", 2), f.io).ok,
  ).toBe(true);
});
