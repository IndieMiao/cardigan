import { expect, test } from "vitest";
import {
  type Actor,
  type Card,
  type CommandState,
  cardFlowVersion,
  createCard,
  type Delivery,
  type Event,
  FLOW_VERSION_MAX,
  flowAtLeast,
  projectFlowVersion,
  projectSnapshot,
  setProjectPreferences,
  upgradeCardFlow,
} from "../index.js";
import {
  actor,
  apply,
  card,
  fixture,
  human,
  id,
  now,
  ports,
  value,
} from "./test-fixtures.js";

const target = id("card", 1);
const params = { card_id: target, to: 1 };
const system: Actor = { kind: "system", project_id: human.project_id };
const seed = (patch: Partial<Card> = {}): CommandState => ({
  ...fixture(),
  cards: [{ ...card(), ...patch }, card(2)],
});
const completion = (status: Delivery["status"]): Delivery => ({
  id: id("delivery", 1),
  work_item_id: id("work_item", 1),
  run_id: id("run", 1),
  kind: "card_completion",
  summary: "Fixture",
  subject: { kind: "doc_version", value: "1" },
  evidence: [],
  attachments: [],
  known_gaps: [],
  requested_verifiers: [],
  status,
});
const check = (
  seq: number,
  status: string,
  attempt = "check-1",
  card_id = target,
): Event => ({
  id: String(seq).padStart(26, "0") as Event["id"],
  card_id,
  seq,
  type:
    status === "queued"
      ? "merge_check_queued"
      : status === "running"
        ? "merge_check_started"
        : "merge_check_finished",
  actor: system,
  payload: { attempt_id: attempt, completion_id: attempt, status },
  created_at: now,
});

test("flow levels through 5 are released; old cards and absent preferences default to 1", () => {
  expect(FLOW_VERSION_MAX).toBe(5);
  expect(cardFlowVersion(card())).toBe(1);
  expect(projectFlowVersion()).toBe(1);
  expect(flowAtLeast(card(), 1)).toBe(true);
  expect(flowAtLeast(card(), 2)).toBe(false);
  const state = seed();
  expect(value(projectSnapshot(state, human)).data.cards[0]?.flow_version).toBe(
    1,
  );
  expect(state.cards[0]?.flow_version).toBeUndefined();
});

test.each([undefined, 1, 2, 3, 4, 5])(
  "new cards fix the current preference (%s) without changing history",
  (version) => {
    const initial = seed();
    const state = {
      ...initial,
      project_preferences:
        version === undefined
          ? []
          : [
              {
                id: initial.project_id,
                auto_merge_after_minutes: null,
                flow_version: version,
                system_merge_shadow_policy: {
                  role_rule_paths: [],
                  release_paths: [],
                },
              },
            ],
    };
    const effect = value(
      createCard(
        state,
        human,
        {
          title: "Flow fixture",
          goal: "Fix flow",
          acceptance_criteria: ["Fixed"],
          source: { kind: "quote", text: "Fixture" },
          repo: "example/repo",
          base_branch: "main",
        },
        ports(),
      ),
    );
    expect(effect.data.flow_version).toBe(version ?? 1);
    const after = apply(state, effect);
    expect(after.cards.find((c) => c.id === target)).toBe(initial.cards[0]);
    expect(effect.events.find((e) => e.type === "card_created")?.actor).toEqual(
      human,
    );
    const saved = value(
      setProjectPreferences(
        after,
        human,
        { flow_version: version ?? 1 },
        ports(),
      ),
    );
    expect(saved.changes).toEqual([]);
    expect(saved.events).toEqual([]);
    expect(saved.timeline).toEqual([]);
    expect(after.cards.find((c) => c.id === effect.data.id)?.flow_version).toBe(
      version ?? 1,
    );
  },
);

test.each([0, -1, 1.5, 6, 7, Number.NaN, Infinity, "1", null])(
  "invalid or unreleased flow %s is rejected atomically",
  (bad) => {
    const state = seed();
    const before = JSON.parse(JSON.stringify(state));
    expect(
      setProjectPreferences(
        state,
        human,
        { flow_version: bad as number },
        ports(),
      ),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    expect(
      upgradeCardFlow(state, human, { ...params, to: bad as number }, ports()),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    expect(state).toEqual(before);
  },
);

test("unreleased persisted preferences cannot create a future-flow card", () => {
  const state = {
    ...seed(),
    project_preferences: [
      { id: human.project_id, auto_merge_after_minutes: null, flow_version: 6 },
    ],
  };
  expect(
    createCard(
      state,
      human,
      {
        title: "No",
        goal: "No",
        acceptance_criteria: ["Fixed"],
        source: { kind: "quote", text: "No" },
        repo: "example/repo",
        base_branch: "main",
      },
      ports(),
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});

test("only human actors can write preferences or upgrade, including Office/Ops and other agents", () => {
  const base = seed();
  const pm = base.assignments.find((a) => a.scope === "standing");
  if (!pm) throw new Error("Missing PM");
  for (const mode of ["office", "ops"] as const) {
    const state = {
      ...base,
      assignments: base.assignments.map((a) =>
        a.id === pm.id ? { ...pm, standing_mode: mode } : a,
      ),
    };
    for (const caller of [
      actor(1),
      actor(2, "reviewer"),
      actor(3, "pm"),
      actor(4, "pm"),
      { ...actor(1), role_id: "host_ops" },
      { ...actor(1), role_id: "independent_reviewer" },
      system,
    ]) {
      expect(
        setProjectPreferences(state, caller, { flow_version: 2 }, ports()).ok,
      ).toBe(false);
      expect(
        upgradeCardFlow(state, caller, { ...params, to: 2 }, ports()),
      ).toMatchObject({
        ok: false,
        error: { code: "unauthorized", message: "只有人能变更卡片流程版本" },
      });
    }
  }
  expect(
    upgradeCardFlow(base, { ...human, project_id: "other" }, params, ports())
      .ok,
  ).toBe(false);
});

test.each(["done", "cancelled", "awaiting_merge"] as const)(
  "rejects %s even for the same version",
  (status) => {
    expect(
      upgradeCardFlow(seed({ status }), human, params, ports()),
    ).toMatchObject({
      ok: false,
      error: {
        code: "illegal_transition",
        message: expect.stringContaining("不能变更流程版本"),
      },
    });
  },
);

test.each(["submitted", "accepted", "rejected"] as const)(
  "rejects non-void completion %s",
  (status) => {
    expect(
      upgradeCardFlow(
        { ...seed(), deliveries: [completion(status)] },
        human,
        params,
        ports(),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "illegal_transition",
        message: expect.stringContaining("未作废的完成申请"),
      },
    });
  },
);

test("void completion and another card's completion do not block", () => {
  for (const delivery of [
    completion("superseded"),
    { ...completion("accepted"), work_item_id: id("work_item", 99) },
  ])
    expect(
      value(
        upgradeCardFlow(
          { ...seed(), deliveries: [delivery] },
          human,
          params,
          ports(),
        ),
      ).events,
    ).toEqual([]);
});

test.each(["queued", "running"])(
  "rejects %s check even after its completion was voided",
  (status) => {
    const state = {
      ...seed(),
      deliveries: [completion("superseded")],
      events: [check(1, status)],
    };
    expect(upgradeCardFlow(state, human, params, ports())).toMatchObject({
      ok: false,
      error: {
        code: "illegal_transition",
        message: expect.stringContaining("排队中或运行中"),
      },
    });
  },
);

test("check history uses sequence and each completion, isolates other cards and accepts finished attempts", () => {
  expect(
    upgradeCardFlow(
      { ...seed(), events: [check(4, "passed", "other"), check(1, "running")] },
      human,
      params,
      ports(),
    ).ok,
  ).toBe(false);
  const events = [
    check(2, "passed"),
    check(1, "running"),
    check(3, "queued", "other", id("card", 2)),
  ];
  expect(
    value(upgradeCardFlow({ ...seed(), events }, human, params, ports()))
      .events,
  ).toEqual([]);
});

// A version 2 card may downgrade only before work starts.
test.each(["backlog", "todo"] as const)(
  "%s downgrade is audited once, replay has no effect",
  (status) => {
    const state = seed({ status, flow_version: 2 });
    const io = ports();
    const effect = value(upgradeCardFlow(state, human, params, io));
    expect(effect.changes).toEqual([
      { collection: "cards", entity: { ...state.cards[0], flow_version: 1 } },
    ]);
    expect(effect.events).toHaveLength(1);
    expect(effect.events[0]).toMatchObject({
      type: "card_flow_upgraded",
      actor: human,
      payload: {
        card_id: target,
        old_value: 2,
        new_value: 1,
        upgraded_by: "human",
      },
    });
    expect(effect.timeline[0]).toMatchObject({
      author: "human",
      type: "status_change",
      body: "人将卡片流程版本从 2 调整为 1",
    });
    const after = apply(state, effect);
    expect(after.work_items).toBe(state.work_items);
    expect(after.decisions).toBe(state.decisions);
    const replay = value(upgradeCardFlow(after, human, params, io));
    expect(replay.changes).toEqual([]);
    expect(replay.events).toEqual([]);
    expect(replay.timeline).toEqual([]);
  },
);

test.each(["in_progress", "review"] as const)(
  "%s cannot downgrade",
  (status) => {
    expect(
      upgradeCardFlow(
        seed({ status, flow_version: 2 }),
        human,
        params,
        ports(),
      ),
    ).toMatchObject({
      ok: false,
      error: {
        code: "illegal_transition",
        message: "只有待规划或待开始的卡片可以降低流程版本",
      },
    });
  },
);

test("same version keeps legacy fields and all control-plane state unchanged", () => {
  const state = seed();
  const effect = value(upgradeCardFlow(state, human, params, ports()));
  expect(effect.data).toBe(state.cards[0]);
  expect(apply(state, effect)).toEqual(state);
  expect(effect.changes).toEqual([]);
  expect(effect.events).toEqual([]);
});

test("preference changes audit the human and keep all existing card versions fixed", () => {
  const state = {
    ...seed(),
    project_preferences: [
      { id: human.project_id, auto_merge_after_minutes: null, flow_version: 1 },
    ],
  };
  const effect = value(
    setProjectPreferences(state, human, { flow_version: 2 }, ports()),
  );
  expect(effect.events).toHaveLength(1);
  expect(effect.events[0]).toMatchObject({
    actor: human,
    type: "project_preferences_updated",
    payload: { preference: "flow_version", old_value: 1, new_value: 2 },
  });
  expect(effect.changes.map((c) => c.collection)).toEqual([
    "project_preferences",
  ]);
  expect(apply(state, effect).cards).toBe(state.cards);
});

test("human explicitly upgrades a safe legacy card to 2 without changing its peers", () => {
  const state = seed({ status: "in_progress" });
  const effect = value(
    upgradeCardFlow(state, human, { ...params, to: 2 }, ports()),
  );
  const after = apply(state, effect);
  expect(after.cards.find((c) => c.id === target)?.flow_version).toBe(2);
  expect(after.cards.find((c) => c.id === id("card", 2))).toBe(state.cards[1]);
  expect(effect.events).toMatchObject([
    {
      type: "card_flow_upgraded",
      actor: human,
      payload: { old_value: 1, new_value: 2, upgraded_by: "human" },
    },
  ]);
  expect(flowAtLeast(effect.data, 2)).toBe(true);
  expect(flowAtLeast(effect.data, 3)).toBe(false);
  expect(
    value(upgradeCardFlow(after, human, { ...params, to: 2 }, ports())).events,
  ).toEqual([]);
});

test.each([4, 5])(
  "flow %i requires explicit release paths without mutating legacy preferences",
  (version) => {
    for (const policy of [
      undefined,
      null,
      {},
      { role_rule_paths: ["AGENTS.md"] },
    ]) {
      // Persisted legacy JSON can omit fields required by today's policy type.
      const state = JSON.parse(
        JSON.stringify({
          ...seed(),
          project_preferences: [
            {
              id: human.project_id,
              auto_merge_after_minutes: null,
              flow_version: 1,
              ...(policy === undefined
                ? {}
                : { system_merge_shadow_policy: policy }),
            },
          ],
        }),
      ) as CommandState;
      const before = JSON.parse(JSON.stringify(state));
      expect(
        setProjectPreferences(state, human, { flow_version: version }, ports()),
      ).toMatchObject({
        ok: false,
        error: {
          code: "validation_failed",
          message: expect.stringContaining(
            "启用系统合并前须由人显式设置发布路径",
          ),
        },
      });
      expect(state).toEqual(before);
    }
    const saved = value(
      setProjectPreferences(
        seed(),
        human,
        {
          flow_version: version,
          system_merge_shadow_policy: {
            role_rule_paths: [],
            release_paths: [],
          },
        },
        ports(),
      ),
    );
    expect(saved.data.flow_version).toBe(version);
    expect(saved.data.system_merge_shadow_policy?.release_paths).toEqual([]);
  },
);
