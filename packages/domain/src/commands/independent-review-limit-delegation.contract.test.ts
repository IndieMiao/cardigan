import { expect, test } from "vitest";
import {
  recordDecision,
  requestDecision,
  resolveDelegatedDecision,
  setCardSensitive,
  setProjectPreferences,
  updateWorkItem,
} from "../index.js";
import { independentReviewLimitFixture as setup } from "./independent-review-limit/test-fixtures.js";
import { human, value } from "./test-fixtures.js";

test.each([
  {},
  { independent_review_limit_delegation: false },
  { independent_review_limit_delegation: true },
  ...[null, 0, -1, 1, 2, 4, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1].map(
    (max) => ({
      independent_review_limit_delegation: true,
      independent_review_limit_delegation_max: max,
    }),
  ),
])(
  "missing, disabled or invalid authorization fails closed: %j",
  async (preferences) => {
    const t = setup(preferences);
    await t.limited();
    expect(t.decision()).toMatchObject({
      decider: "human",
      human_required_reason: "独立复核审核轮数已用完，必须由人确认后续处理",
    });
    expect(t.resolve().ok).toBe(false);
  },
);

test("only human changes authorization or its bound; enabling without a bound fails", () => {
  const t = setup({});
  for (const actor of [
    t.pm,
    t.f.actor(t.owner),
    t.f.actor(t.f.coder),
    { kind: "system", project_id: human.project_id } as const,
  ])
    for (const input of [
      { independent_review_limit_delegation: true },
      { independent_review_limit_delegation_max: 3 },
    ])
      expect(setProjectPreferences(t.f.state, actor, input, t.f.io).ok).toBe(
        false,
      );
  expect(
    setProjectPreferences(
      t.f.state,
      human,
      { independent_review_limit_delegation: true },
      t.f.io,
    ).ok,
  ).toBe(false);
  for (const max of [0, -1, 1, 2, 4, 1.5, Number.NaN, Infinity])
    expect(
      setProjectPreferences(
        t.f.state,
        human,
        { independent_review_limit_delegation_max: max },
        t.f.io,
      ).ok,
    ).toBe(false);
  t.f.commit(
    setProjectPreferences(
      t.f.state,
      human,
      {
        independent_review_limit_delegation: true,
        independent_review_limit_delegation_max: 3,
      },
      t.f.io,
    ),
  );
  expect(
    t.f.state.events.filter((e) => e.type === "project_preferences_updated"),
  ).toHaveLength(2);
});

test("new versions consume lifetime grants once, with version/authority/notice audit; toggling does not reset", async () => {
  const t = setup();
  const target = await t.limited();
  expect(t.decision()).toMatchObject({
    decider: "role:pm",
    delegation_authority: expect.stringContaining(
      "independent_review_limit_delegation",
    ),
  });
  expect(t.decision().human_required_reason).toBeUndefined();
  t.f.commit(t.resolve("pause"));
  expect(t.decision().status).toBe("provisional");
  t.f.commit(t.resolve());
  expect(t.resolve().ok).toBe(false);
  expect(t.decision().resolution).toMatchObject({
    via: "delegated",
    option: "raise_limit",
    proxy_authority: expect.stringContaining(
      "independent_review_limit_delegation",
    ),
    review_limit_target: { delivery_id: target.id, subject: target.subject },
    notice: expect.stringContaining("按常驻授权代批"),
  });
  expect(
    t.f.state.timeline.some((entry) => entry.body.includes("按常驻授权代批")),
  ).toBe(true);
  expect(t.f.state.work_items.find((w) => w.id === t.item.id)).toMatchObject({
    status: "ready",
    max_review_rounds: 2,
  });
  t.review(target);
  for (const on of [false, true])
    t.f.commit(
      setProjectPreferences(
        t.f.state,
        human,
        { independent_review_limit_delegation: on },
        t.f.io,
      ),
    );
  const next = await t.f.deliver("code", "c".repeat(40));
  t.f.commit(t.resolve());
  t.review(next);
  const third = await t.f.deliver("code", "d".repeat(40));
  t.f.commit(t.resolve());
  t.review(third);
  await t.f.deliver("code", "e".repeat(40));
  expect(t.decision()).toMatchObject({
    decider: "human",
    human_required_reason: expect.any(String),
  });
  expect(t.resolve().ok).toBe(false);
});

test("a changed delivery ID with the same SHA is a new version", async () => {
  const t = setup();
  t.review(await t.f.deliver());
  await t.f.deliver();
  expect(t.decision().decider).toBe("role:pm");
  expect(t.resolve().ok).toBe(true);
});

test("same-version re-review stays human; a later delivery never reassigns an existing human decision", async () => {
  const t = setup();
  t.review(await t.f.deliver(), true);
  const q = t.decision();
  expect(q).toMatchObject({
    decider: "human",
    human_required_reason: expect.any(String),
  });
  await t.f.deliver("code", "b".repeat(40));
  expect(t.decision()).toEqual(q);
  expect(t.resolve().ok).toBe(false);
});

test.each([
  "close",
  "sensitive",
  "escalate",
  "generic-escalate",
  "human-pause",
] as const)(
  "%s returns a pending grant permanently to the human",
  async (action) => {
    const t = setup();
    await t.limited();
    if (action === "close")
      t.f.commit(
        setProjectPreferences(
          t.f.state,
          human,
          { independent_review_limit_delegation: false },
          t.f.io,
        ),
      );
    if (action === "sensitive")
      t.f.commit(
        setCardSensitive(
          t.f.state,
          human,
          { card_id: t.f.card.id, sensitive: true },
          t.f.io,
        ),
      );
    if (action === "escalate") t.f.commit(t.resolve("escalate"));
    if (action === "generic-escalate")
      t.f.commit(
        resolveDelegatedDecision(
          t.f.state,
          t.pm,
          {
            decision_id: t.decision().id,
            option: "raise_limit",
            escalate: true,
            rationale: "Need human review",
            plain_summary: {
              changed: "需要你确认是否继续复核",
              impact: "确认后才能继续",
              risk: "无",
            },
          },
          t.f.io,
        ),
      );
    if (action === "human-pause")
      t.f.commit(
        recordDecision(
          t.f.state,
          human,
          {
            decision_id: t.decision().id,
            option: "pause",
            rationale: "Wait",
            raw_quote: "Wait",
          },
          t.f.io,
        ),
      );
    expect(t.decision().decider).toBe("human");
    expect(t.decision().human_required_reason).toBeTruthy();
    const officeState = {
      ...t.f.state,
      assignments: t.f.state.assignments.map((a) =>
        a.scope === "standing" && a.id === t.pm.assignment_id
          ? { ...a, standing_mode: "office" as const }
          : a,
      ),
    };
    expect(
      recordDecision(
        officeState,
        { ...t.pm, allowed_tools: [...t.pm.allowed_tools, "record_decision"] },
        {
          decision_id: t.decision().id,
          option: "raise_limit",
          rationale: "Transcribe",
          raw_quote: "Transcribe",
        },
        t.f.io,
      ),
    ).toMatchObject({ ok: false, error: { code: "forbidden_tool" } });
    t.f.commit(
      setProjectPreferences(
        t.f.state,
        human,
        {
          independent_review_limit_delegation: true,
          independent_review_limit_delegation_max: 3,
        },
        t.f.io,
      ),
    );
    expect(t.resolve().ok).toBe(false);
  },
);

test.each([
  "spending",
  "account",
  "permission",
  "data_deletion",
  "scope_change",
] as const)(
  "%s on the card forces a human even after resolved",
  async (category) => {
    const t = setup();
    await t.limited();
    const q = t.f.commit(
      requestDecision(
        t.f.state,
        human,
        {
          card_id: t.f.card.id,
          category,
          kind: "choose",
          question: "Confirm change",
          context: "Human decides",
          options: [{ key: "yes", description: "Proceed", impact: "Continue" }],
          recommended: "yes",
          affected_cards: [t.f.card.id],
          affected_work_items: [],
          blocking: false,
          decider: "human",
          plain_summary: {
            changed: "请确认这项变更",
            impact: "影响后续工作",
            risk: "无",
          },
        },
        t.f.io,
      ),
    );
    expect(t.decision()).toMatchObject({
      decider: "human",
      human_required_reason: expect.any(String),
    });
    t.f.commit(
      recordDecision(
        t.f.state,
        human,
        {
          decision_id: q.id,
          option: "yes",
          rationale: "Confirmed",
          raw_quote: "Confirmed",
        },
        { ...t.f.io, human_confirmation: "workbench" },
      ),
    );
    expect(t.resolve().ok).toBe(false);
  },
);

test("current transaction rejects stale authorization and non-Ops identities", async () => {
  const t = setup();
  await t.limited();
  for (const actor of [
    t.f.actor(t.owner),
    t.f.actor(t.f.coder),
    t.f.actor(t.f.pm),
  ])
    expect(t.resolve("raise_limit", actor).ok).toBe(false);
  const officeState = {
    ...t.f.state,
    assignments: t.f.state.assignments.map((a) =>
      a.scope === "standing" &&
      a.id === (t.pm.kind === "assignment" ? t.pm.assignment_id : "")
        ? { ...a, standing_mode: "office" as const }
        : a,
    ),
  };
  expect(
    updateWorkItem(
      officeState,
      t.pm,
      {
        work_item_id: t.item.id,
        review_limit_decision: {
          decision_id: t.decision().id,
          option: "raise_limit",
          rationale: "No",
        },
      },
      t.f.io,
    ).ok,
  ).toBe(false);
  const sensitiveState = {
    ...t.f.state,
    cards: t.f.state.cards.map((c) => ({ ...c, sensitive: true })),
  };
  expect(
    updateWorkItem(
      sensitiveState,
      t.pm,
      {
        work_item_id: t.item.id,
        review_limit_decision: {
          decision_id: t.decision().id,
          option: "raise_limit",
          rationale: "No",
        },
      },
      t.f.io,
    ).ok,
  ).toBe(false);
  expect(
    value(
      setProjectPreferences(
        t.f.state,
        human,
        { independent_review_limit_delegation: false },
        t.f.io,
      ),
    ).changes.some((c) => c.collection === "decisions"),
  ).toBe(true);
});
