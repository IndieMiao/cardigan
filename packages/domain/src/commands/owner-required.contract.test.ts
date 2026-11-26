import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  type CommandState,
  listNeedsYou,
  OWNER_REQUIRED_WINDOW_DAYS,
  projectSnapshot,
  type RequestDecisionParams,
  referenceProjectSnapshot,
  requestDecision,
  setProjectPreferences,
} from "../index.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  id,
  now,
  ports,
  value,
} from "./test-fixtures.js";

const office = actor(4, "pm");
const ops = actor(5, "pm");
const declaration = {
  reason: "鸡场美术须所有者本人看图",
  basis: "本卡验收第 4 条：美术由所有者看图确认",
};
const params: RequestDecisionParams = {
  card_id: id("card", 1),
  category: "feature_detail",
  kind: "choose",
  question: "鸡场美术是否采用第二版？",
  context: "两版截图已附在卡上",
  options: [
    { key: "v2", description: "采用第二版", impact: "按第二版出图" },
    { key: "v1", description: "保留第一版", impact: "不改动" },
  ],
  recommended: "v2",
  affected_cards: [],
  affected_work_items: [],
  blocking: false,
  decider: "human",
  plain_summary: {
    changed: "鸡场美术换成第二版",
    impact: "游戏里的鸡场画面会变",
    risk: "无",
  },
  suggestion: { option: "v2", rationale: "第二版更贴近参考图" },
};

/** feature_detail delegated to PM, with Office (A-4) and Ops (A-5) on duty. */
function setup() {
  const base = fixture();
  const { work_item_id: _work, ...rest } = assignment(5, "pm");
  const standingOps: Assignment = {
    ...rest,
    scope: "standing",
    standing_mode: "ops",
  };
  const io = ports();
  const state: CommandState = {
    ...base,
    assignments: [...base.assignments, standingOps],
  };
  return {
    io,
    state: apply(
      state,
      value(
        setProjectPreferences(
          state,
          human,
          { decision_delegation: { feature_detail: true } },
          io,
        ),
      ),
    ),
  };
}

test.each([
  ["PM Office", office],
  ["PM Ops", ops],
] as const)(
  "C-753: %s declaring owner-required sends the question straight to the owner",
  (_name, raiser) => {
    const f = setup();
    const effect = value(
      requestDecision(
        f.state,
        raiser,
        {
          ...params,
          owner_required: {
            reason: ` ${declaration.reason} `,
            basis: ` ${declaration.basis}\n`,
          },
        },
        f.io,
      ),
    );
    const q = effect.data;
    expect(q).toMatchObject({
      decider: "human",
      owner_required: {
        ...declaration,
        declared_by: raiser.kind === "assignment" ? raiser.assignment_id : "",
        declared_at: now,
      },
      human_required_reason: `${declaration.reason}（依据：${declaration.basis}）`,
    });
    expect(q.delegation_authority).toBeUndefined();
    expect(q).not.toHaveProperty("routed_to");
    // Audit: who declared (event actor) and on what basis (payload).
    const requested = effect.events.filter(
      (e) => e.type === "decision_requested",
    );
    expect(requested).toHaveLength(1);
    expect(requested[0]).toMatchObject({
      actor: raiser,
      payload: { decision_id: q.id, owner_required: declaration },
    });
    expect(requested[0]?.payload).not.toHaveProperty("routed_to");
    expect(requested[0]?.payload).not.toHaveProperty("previous_decider");
    expect(effect.timeline[0]?.body).toBe(
      `${params.question}\n须由所有者本人决定：${declaration.reason}（依据：${declaration.basis}）`,
    );
    let state = apply(f.state, effect);
    const needs = value(listNeedsYou(state, human)).data;
    expect(needs.decisions).toContainEqual(
      expect.objectContaining({ id: q.id, decider: "human" }),
    );
    expect(value(listNeedsYou(state, ops)).data.pm_queue?.decisions).toEqual(
      [],
    );
    // Turning the category off and on again never reclaims the question.
    for (const feature_detail of [false, true])
      state = apply(
        state,
        value(
          setProjectPreferences(
            state,
            human,
            { decision_delegation: { feature_detail } },
            f.io,
          ),
        ),
      );
    expect(state.decisions.find((d) => d.id === q.id)).toMatchObject({
      decider: "human",
      status: "open",
      owner_required: declaration,
    });
  },
);

test("C-753: without a declaration the same question still follows category delegation", () => {
  const f = setup();
  for (const extra of [
    {},
    { human_required_reason: declaration.reason },
  ] as const) {
    const effect = value(
      requestDecision(f.state, office, { ...params, ...extra }, f.io),
    );
    expect(effect.data).toMatchObject({
      decider: "role:pm",
      routed_to: "role:pm",
    });
    expect(effect.data.owner_required).toBeUndefined();
    expect(effect.data.delegation_authority).toContain(
      "decision-delegation/feature_detail",
    );
    expect(effect.events[0]?.payload).not.toHaveProperty("owner_required");
    expect(effect.timeline[0]?.body).toBe(
      `${params.question}\n已按常驻授权转给 PM`,
    );
  }
});

test.each([
  ["coder", actor()],
  ["reviewer", actor(2, "reviewer")],
  ["work-item PM", actor(3, "pm")],
  ["human", human],
] as const)("C-753: %s cannot declare owner-required", (_name, raiser) => {
  const f = setup();
  expect(
    requestDecision(
      f.state,
      raiser as Actor,
      { ...params, owner_required: declaration },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
});

test("C-753: a declaration needs a reason, a basis and the human as decider", () => {
  const f = setup();
  for (const owner_required of [
    { reason: "", basis: declaration.basis },
    { reason: " \n", basis: declaration.basis },
    { reason: declaration.reason, basis: "" },
    { reason: declaration.reason, basis: "  " },
    { reason: declaration.reason },
    { basis: declaration.basis },
    { reason: declaration.reason, basis: 4 },
  ])
    expect(
      requestDecision(
        f.state,
        office,
        { ...params, owner_required } as RequestDecisionParams,
        f.io,
      ),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  expect(
    requestDecision(
      f.state,
      ops,
      { ...params, decider: "role:pm", owner_required: declaration },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});

test("C-753: project_snapshot lists the last seven days of declarations with their basis", () => {
  const f = setup();
  let state = f.state;
  const declare = (at: string, raiser: Actor, basis: string) => {
    const effect = value(
      requestDecision(
        state,
        raiser,
        { ...params, owner_required: { reason: declaration.reason, basis } },
        { ...f.io, clock: { now: () => at } },
      ),
    );
    state = apply(state, effect);
    return effect.data.id;
  };
  const old = declare("2026-01-01T00:00:00.000Z", office, "项目规则第 1 条");
  const recent = declare(
    "2026-01-06T00:00:00.000Z",
    ops,
    "所有者原话：我要亲自看图",
  );
  const latest = declare("2026-01-08T12:00:00.000Z", office, declaration.basis);
  const at = "2026-01-09T00:00:00.000Z";
  // An ordinary delegated question is not counted.
  state = apply(
    state,
    value(
      requestDecision(state, office, params, {
        ...f.io,
        clock: { now: () => at },
      }),
    ),
  );
  expect(OWNER_REQUIRED_WINDOW_DAYS).toBe(7);
  const snapshot = value(projectSnapshot(state, human, at)).data;
  expect(snapshot.owner_required_decisions).toEqual({
    window_days: 7,
    count: 2,
    items: [
      {
        decision_id: latest,
        card_id: id("card", 1),
        category: "feature_detail",
        status: "open",
        declared_by: id("assignment", 4),
        declared_at: "2026-01-08T12:00:00.000Z",
        reason: declaration.reason,
        basis: declaration.basis,
      },
      expect.objectContaining({
        decision_id: recent,
        declared_by: id("assignment", 5),
        basis: "所有者原话：我要亲自看图",
      }),
    ],
  });
  expect(
    value(
      projectSnapshot(state, human, "2026-01-07T00:00:00.000Z"),
    ).data.owner_required_decisions.items.map((q) => q.decision_id),
  ).toEqual([recent, old]);
  expect(
    value(referenceProjectSnapshot(state, ops, at)).data
      .owner_required_decisions,
  ).toEqual(snapshot.owner_required_decisions);
  // Without an explicit time the window ends at the latest event.
  expect(
    value(projectSnapshot(state, human)).data.owner_required_decisions,
  ).toEqual(snapshot.owner_required_decisions);
});
