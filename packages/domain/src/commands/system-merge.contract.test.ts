import { expect, test } from "vitest";
import {
  autoConfirmMerge,
  type CommandState,
  type Decision,
  type DecisionCategory,
  FLOW_VERSION_MAX,
  humanMergeBlockers,
  listNeedsYou,
  mergePlan,
  notices,
  pmMergeBlockers,
  recordDecision,
  recordMergeResult,
  requestDecision,
  setCardSensitive,
  setProjectPreferences,
  systemConfirmMerge,
  systemMergeAuthority,
  systemMergeHumanReason,
  updateCard,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import {
  pathEvidence,
  policy,
  system,
  systemMergeFixture,
} from "./system-merge/test-fixtures.js";
import { apply, human, id, value } from "./test-fixtures.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture value");
  return value;
}
const confirm = (
  s: CommandState,
  q: Decision,
  io: ReturnType<typeof mergeFixture>["io"],
) => systemConfirmMerge(s, system, { decision_id: q.id }, io);
const changeProduct = (s: CommandState, evidence = pathEvidence()) => ({
  ...s,
  deliveries: s.deliveries.map((v) =>
    v.kind === "code" ? { ...v, evidence } : v,
  ),
});

for (const policy of ["confirm", "auto"] as const)
  test(`A3: ${policy} templates use system consent, with notice only; publication alone completes the card`, async () => {
    const { f, q, completion, check } = await systemMergeFixture({ policy });
    expect(q).toMatchObject({ decider: "system", status: "open" });
    expect(mergePlan(f.state, f.card.id).ok).toBe(false);
    expect(value(listNeedsYou(f.state, human)).data.decisions).toEqual([]);
    check();
    expect(pmMergeBlockers(f.state, q)).toEqual([]);
    const effect = value(confirm(f.state, q, f.io));
    expect(effect.data.resolution).toMatchObject({
      resolved_by: "system",
      via: "system_rule",
      option: "merge",
      proxy_authority: systemMergeAuthority(f.state),
    });
    f.commit({ ok: true, value: effect });
    expect(f.state.cards[0]?.status).toBe("awaiting_merge");
    expect(mergePlan(f.state, f.card.id).ok).toBe(true);
    expect(notices(f.state)).toMatchObject([
      { kind: "merge", resolved_by: "system", decision_id: q.id },
    ]);
    expect(value(listNeedsYou(f.state, human)).data.decisions).toEqual([]);
    expect(value(confirm(f.state, q, f.io)).events).toEqual([]);
    f.commit(
      recordMergeResult(
        { ...f.state, project_settings: { merge_gate_enabled: true } },
        system,
        {
          card_id: f.card.id,
          completion_id: completion.id,
          result: {
            kind: "merged",
            merge_sha: "d".repeat(40),
            previous_sha: "b".repeat(40),
            tree_sha: "c".repeat(40),
          },
        },
        f.io,
      ),
    );
    expect(f.state.cards[0]?.status).toBe("done");
    expect(f.state.events.filter((e) => e.type === "card_merged")).toHaveLength(
      1,
    );
  });

test("A3: only same-project system can confirm; callers cannot create system decisions or answer on its behalf", async () => {
  const { f, q, check } = await systemMergeFixture();
  check();
  for (const caller of [
    human,
    f.actor(f.coder),
    f.actor(f.pm),
    { ...system, project_id: "other" },
  ])
    expect(
      systemConfirmMerge(f.state, caller, { decision_id: q.id }, f.io).ok,
    ).toBe(false);
  expect(
    requestDecision(
      f.state,
      human,
      {
        card_id: f.card.id,
        category: "general",
        question: "Fake?",
        context: "Fake",
        kind: "choose",
        target: { subject: { kind: "doc_version", value: "1" } },
        options: [{ key: "yes", description: "yes", impact: "none" }],
        affected_cards: [],
        affected_work_items: [],
        blocking: false,
        recommended: "yes",
        decider: "system",
      },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    autoConfirmMerge(f.state, system, { decision_id: q.id }, f.io).ok,
  ).toBe(false);
});

const reasons: [string, (s: CommandState) => CommandState][] = [
  [
    "sensitive",
    (s) => ({ ...s, cards: s.cards.map((c) => ({ ...c, sensitive: true })) }),
  ],
  [
    "release path",
    (s) => changeProduct(s, pathEvidence(["release/artifact.zip"])),
  ],

  ["missing D6", (s) => changeProduct(s, [])],
  [
    "missing configuration",
    (s) => ({
      ...s,
      project_preferences: [
        { id: s.project_id, auto_merge_after_minutes: null, flow_version: 4 },
      ],
    }),
  ],
  [
    "missing preference audit",
    (s) => ({
      ...s,
      events: s.events.filter((e) => e.type !== "project_preferences_updated"),
    }),
  ],
];
for (const [name, mutate] of reasons)
  test(`A3: ${name} alone routes human at completion and supersedes unpublished system authority`, async () => {
    const initial = await systemMergeFixture({ beforeReview: mutate });
    expect(initial.q).toMatchObject({
      decider: "human",
      human_required_reason: expect.any(String),
    });
    const { f, q, check } = await systemMergeFixture();
    check();
    f.commit(confirm(f.state, q, f.io));
    const stale = mutate(f.state);
    expect(mergePlan(stale, f.card.id).ok).toBe(false);
    const effect = value(confirm(stale, q, f.io));
    const updated = apply(stale, effect);
    expect(updated.decisions.find((v) => v.id === q.id)).toMatchObject({
      status: "superseded",
      resolution: { via: "system_rule" },
    });
    expect(updated.decisions.at(-1)).toMatchObject({
      decider: "human",
      status: "open",
      human_required_reason: expect.any(String),
      amends: q.id,
    });
    expect(value(confirm(updated, q, f.io)).events).toEqual([]);
  });

test.each(["spending", "account", "credential", "data_deletion", "publish"])(
  "A3: related/source %s requires human even after personal resolution",
  async (category) => {
    const { f, q, check } = await systemMergeFixture();
    check();
    const { trigger: _trigger, ...content } = q;
    const other: Decision = {
      ...content,
      id: id("decision", 700),
      key: id("decision", 700),
      category: category as DecisionCategory,
      decider: "human",
      status: "resolved",
      resolution: {
        option: "merge",
        rationale: "Approved",
        raw_quote: "Approved",
        resolved_by: "human",
        via: "needs_you",
        via_chain: ["human"],
        at: "2026-01-01T00:00:00Z",
      },
    };
    for (const source of [false, true]) {
      const { card_id: _card, ...projectQuestion } = other;
      const s = {
        ...f.state,
        decisions: [
          ...f.state.decisions,
          source ? { ...projectQuestion, affected_cards: [] } : other,
        ],
        cards: f.state.cards.map((c) =>
          source
            ? {
                ...c,
                source: { kind: "decision" as const, decision_id: other.id },
              }
            : c,
        ),
      };
      expect(systemMergeHumanReason(s, q)).toContain("由人");
      const effect = value(confirm(s, q, f.io));
      expect(apply(s, effect).decisions.at(-1)?.decider).toBe("human");
    }
  },
);

const blockers: [string, (s: CommandState) => CommandState][] = [
  [
    "no check",
    (s) => ({
      ...s,
      events: s.events.filter((e) => !e.type.startsWith("merge_check_")),
    }),
  ],
  [
    "required verification",
    (s) => ({
      ...s,
      work_items: s.work_items.map((w) =>
        w.kind === "verify" ? { ...w, status: "todo" as const } : w,
      ),
    }),
  ],
  [
    "optional verification",
    (s) => ({
      ...s,
      work_items: [
        ...s.work_items,
        {
          ...required(s.work_items.find((w) => w.kind === "verify")),
          id: id("work_item", 800),
          required: false,
          status: "todo" as const,
        },
      ],
    }),
  ],
  [
    "required product",
    (s) => ({
      ...s,
      deliveries: s.deliveries.map((v) =>
        v.kind === "code" ? { ...v, status: "rejected" as const } : v,
      ),
    }),
  ],
  [
    "stale review",
    (s) => ({
      ...s,
      reviews: s.reviews.map((r) => ({ ...r, target_sha: "f".repeat(40) })),
    }),
  ],
  [
    "must fix",
    (s) => ({
      ...s,
      reviews: s.reviews.map((r) => ({
        ...r,
        issues: [
          {
            severity: "major" as const,
            description: "Fix",
            must_fix: true,
            pre_existing: false,
          },
        ],
      })),
    }),
  ],
];
for (const [name, mutate] of blockers)
  test(`A3: ${name} independently blocks confirmation and publication without creating a human question`, async () => {
    const { f, q, check } = await systemMergeFixture();
    check();
    const blocked = mutate(f.state);
    expect(pmMergeBlockers(blocked, q).length).toBeGreaterThan(0);
    expect(confirm(blocked, q, f.io).ok).toBe(false);
    expect(blocked.decisions).toHaveLength(1);
    f.commit(confirm(f.state, q, f.io));
    expect(mergePlan(mutate(f.state), f.card.id).ok).toBe(false);
  });

test("A3: pause gates both stages, resume continues, personal confirmation can publish while paused", async () => {
  const { f, q, check } = await systemMergeFixture();
  check();
  f.commit(
    setProjectPreferences(f.state, human, { auto_merge_paused: true }, f.io),
  );
  expect(confirm(f.state, q, f.io).ok).toBe(false);
  f.commit(
    setProjectPreferences(f.state, human, { auto_merge_paused: false }, f.io),
  );
  f.commit(confirm(f.state, q, f.io));
  f.commit(
    setProjectPreferences(f.state, human, { auto_merge_paused: true }, f.io),
  );
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  f.commit(
    setProjectPreferences(f.state, human, { auto_merge_paused: false }, f.io),
  );
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
  const fresh = await systemMergeFixture();
  fresh.check();
  fresh.f.commit(
    setProjectPreferences(
      fresh.f.state,
      human,
      { auto_merge_paused: true },
      fresh.f.io,
    ),
  );
  fresh.f.commit(
    recordDecision(
      fresh.f.state,
      human,
      {
        decision_id: fresh.q.id,
        option: "merge",
        rationale: "Personal",
        raw_quote: "Personal",
      },
      fresh.f.io,
    ),
  );
  expect(mergePlan(fresh.f.state, fresh.f.card.id).ok).toBe(true);
});

test("A3: explicit handoff is sticky, sensitive changes retire system approval immediately", async () => {
  const { f, q, check } = await systemMergeFixture();
  check();
  f.commit(confirm(f.state, q, f.io));
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: true },
      f.io,
    ),
  );
  expect(f.state.decisions.find((v) => v.id === q.id)?.status).toBe(
    "superseded",
  );
  expect(f.state.decisions.at(-1)?.decider).toBe("human");
  const humanQ = required(f.state.decisions.at(-1));
  const handed = {
    ...f.state,
    cards: f.state.cards.map((c) => ({ ...c, sensitive: false })),
    decisions: f.state.decisions.map((v) =>
      v.id === humanQ.id ? { ...v, human_required_reason: "明确交人" } : v,
    ),
  };
  expect(
    systemConfirmMerge(handed, system, { decision_id: humanQ.id }, f.io).ok,
  ).toBe(false);
});

test("A3: activation stays capped; nulling release policy on a future-enabled project is rejected atomically; explicit empty remains valid", async () => {
  const { f, q } = await systemMergeFixture();
  expect(FLOW_VERSION_MAX).toBe(2);
  expect(
    setProjectPreferences(f.state, human, { flow_version: 4 }, f.io).ok,
  ).toBe(false);
  expect(
    setProjectPreferences(
      f.state,
      human,
      { system_merge_shadow_policy: null },
      f.io,
    ).ok,
  ).toBe(false);
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { system_merge_shadow_policy: { ...policy, release_paths: [] } },
      f.io,
    ),
  );
  expect(systemMergeHumanReason(f.state, q)).toBeUndefined();
  for (const a of [f.actor(f.coder), f.actor(f.pm), system])
    expect(
      setProjectPreferences(
        f.state,
        a,
        { system_merge_shadow_policy: { ...policy, release_paths: [] } },
        f.io,
      ).ok,
    ).toBe(false);
});

test("A3: a pending system confirmation carrying explicit human handoff becomes sticky human-only", async () => {
  const { f, q, check } = await systemMergeFixture();
  check();
  const state = {
    ...f.state,
    decisions: f.state.decisions.map((v) => ({
      ...v,
      human_required_reason: "人工接手",
    })),
  };
  const changed = apply(state, value(confirm(state, q, f.io)));
  expect(changed.decisions.at(-1)).toMatchObject({
    decider: "system",
    status: "resolved",
  });
});

test("A3: every risk reviewer must pass on the current delivery id and SHA; withdrawal retires unpublished approval", async () => {
  const { f, q, check, product } = await systemMergeFixture();
  check();
  const independent = required(
    f.state.work_items.find(
      (w) => w.target_work_item_id === product.work_item_id,
    ),
  );
  const ready: CommandState = {
    ...f.state,
    cards: f.state.cards.map((c) => ({
      ...c,
      risk_tags: ["security"],
      high_risk: true,
    })),
    work_items: f.state.work_items.map((w) =>
      w.id === independent.id ? { ...w, role_id: "independent_reviewer" } : w,
    ),
  };
  expect(pmMergeBlockers(ready, q)).toEqual([]);
  const resolved = apply(ready, value(confirm(ready, q, f.io)));
  const ineligible: [string, (s: CommandState) => CommandState][] = [
    [
      "not required",
      (s) => ({
        ...s,
        work_items: s.work_items.map((w) =>
          w.id === independent.id ? { ...w, required: false } : w,
        ),
      }),
    ],
    [
      "wrong target",
      (s) => ({
        ...s,
        work_items: s.work_items.map((w) =>
          w.kind === "verify" && w.id === independent.id
            ? { ...w, target_work_item_id: id("work_item", 999) }
            : w,
        ),
      }),
    ],
    [
      "wrong id",
      (s) => ({
        ...s,
        reviews: s.reviews.map((r) =>
          r.work_item_id === independent.id
            ? { ...r, delivery_id: id("delivery", 999) }
            : r,
        ),
      }),
    ],
    [
      "wrong SHA",
      (s) => ({
        ...s,
        reviews: s.reviews.map((r) =>
          r.work_item_id === independent.id
            ? { ...r, target_sha: "f".repeat(40) }
            : r,
        ),
      }),
    ],
    [
      "withdrawn",
      (s) => ({
        ...s,
        reviews: s.reviews.map((r) =>
          r.work_item_id === independent.id
            ? {
                ...r,
                withdrawn: { at: "2026-01-01T00:00:00Z", rationale: "Recheck" },
              }
            : r,
        ),
      }),
    ],
  ];
  for (const [name, mutate] of ineligible) {
    const pending = mutate(ready);
    expect(pmMergeBlockers(pending, q).length, name).toBeGreaterThan(0);
    expect(confirm(pending, q, f.io).ok, name).toBe(false);
    const stale = mutate(resolved);
    expect(mergePlan(stale, f.card.id).ok, name).toBe(false);
    const updated = apply(stale, value(confirm(stale, q, f.io)));
    expect(updated.decisions.find((v) => v.id === q.id)?.status, name).toBe(
      "superseded",
    );
    expect(updated.decisions.at(-1)?.decider, name).toBe("system");
  }
});

test("A3: release policy changes cannot reuse consent, even when the new paths do not match", async () => {
  const { f, q, check } = await systemMergeFixture();
  check();
  f.commit(confirm(f.state, q, f.io));
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { system_merge_shadow_policy: { ...policy, release_paths: [] } },
      f.io,
    ),
  );
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  f.commit(confirm(f.state, q, f.io));
  expect(f.state.decisions.at(-1)?.decider).toBe("system");
});

test.each([1, 2, 3])(
  "A3: legacy flow %i keeps human confirmation and template auto policy",
  async (flow_version) => {
    for (const mergePolicy of ["confirm", "auto"] as const) {
      const f = mergeFixture(mergePolicy);
      const { completion } = await f.accept();
      const state = {
        ...f.state,
        cards: f.state.cards.map((c) => ({ ...c, flow_version })),
      };
      if (mergePolicy === "auto")
        expect(mergePlan(state, f.card.id).ok).toBe(true);
      else {
        const q = required(state.decisions[0]);
        expect(q.decider).toBe("human");
        expect(
          systemConfirmMerge(state, system, { decision_id: q.id }, f.io).ok,
        ).toBe(false);
        const approved = apply(
          state,
          value(
            recordDecision(
              state,
              human,
              {
                decision_id: q.id,
                option: "merge",
                rationale: "Approved",
                raw_quote: "Approved",
              },
              f.io,
            ),
          ),
        );
        expect(mergePlan(approved, f.card.id).ok).toBe(true);
        expect(completion.status).toBe("submitted");
      }
    }
  },
);

test.each([
  "queued",
  "running",
  "failed",
  "timed_out",
  "interrupted",
  "executor_unreachable",
])("A3: check status %s never authorizes a system merge", async (status) => {
  const { f, q, check } = await systemMergeFixture();
  check();
  const state: CommandState = {
    ...f.state,
    events: f.state.events.map((e) =>
      e.type === "merge_check_finished"
        ? {
            ...e,
            payload: {
              ...(e.payload as Record<
                string,
                import("../entities.js").JsonValue
              >),
              status,
            },
          }
        : e,
    ),
  };
  expect(confirm(state, q, f.io).ok).toBe(false);
  expect(state.decisions).toHaveLength(1);
});

test("A3: missing configuration still permits an emergency human pause; current blockers and stale targets never publish", async () => {
  const { f, q, check, completion } = await systemMergeFixture();
  check();
  const missing = {
    ...f.state,
    project_preferences: [
      {
        id: f.state.project_id,
        flow_version: 4,
        auto_merge_after_minutes: null,
      },
    ],
  };
  expect(
    setProjectPreferences(missing, human, { auto_merge_paused: true }, f.io).ok,
  ).toBe(true);
  const resolved = apply(f.state, value(confirm(f.state, q, f.io)));
  const base = {
    ...q,
    id: id("decision", 801),
    key: id("decision", 801),
    kind: "choose" as const,
    trigger: undefined,
    category: "general" as const,
    decider: "human" as const,
    blocking: true,
    status: "open" as const,
  };
  const { trigger: _trigger, ...blocking } = base;
  const pending = { ...f.state, decisions: [...f.state.decisions, blocking] };
  expect(confirm(pending, q, f.io).ok).toBe(false);
  expect(
    mergePlan(
      { ...resolved, decisions: [...resolved.decisions, blocking] },
      f.card.id,
    ).ok,
  ).toBe(false);
  const stale = {
    ...resolved,
    deliveries: resolved.deliveries.map((v) =>
      v.id === completion.id ? { ...v, status: "superseded" as const } : v,
    ),
  };
  expect(mergePlan(stale, f.card.id).ok).toBe(false);
});

test.each(["pending", "failed", "stale"] as const)(
  "V-1574: ordinary check %s blocks system confirmation, plan and recorded publication",
  async (condition) => {
    const { f, q, check, completion } = await systemMergeFixture();
    check();
    const initial = f.state;
    const approved = apply(initial, value(confirm(initial, q, f.io)));
    const addCheck = (state: CommandState) => {
      const effect = value(
        updateCard(
          state,
          human,
          {
            card_id: f.card.id,
            pre_merge_check: {
              label: "上线前人工核对",
              status: condition === "stale" ? "passed" : condition,
            },
          },
          f.io,
        ),
      );
      const current = apply(state, effect);
      if (condition !== "stale") return current;
      return {
        ...current,
        cards: current.cards.map((c) => ({
          ...c,
          pre_merge_checks: (c.pre_merge_checks ?? []).map((item) => ({
            ...item,
            checked_versions: required(item.checked_versions).map((v) => ({
              ...v,
              subject: "f".repeat(40),
            })),
          })),
        })),
      };
    };
    const waiting = addCheck(initial);
    expect(humanMergeBlockers(waiting, q).join(";")).toContain(
      "上线前人工核对",
    );
    expect(pmMergeBlockers(waiting, q)).toEqual([]);
    expect(confirm(waiting, q, f.io).ok).toBe(false);
    expect(waiting.decisions).toHaveLength(1);
    const reset = addCheck(approved);
    expect(mergePlan(reset, f.card.id).ok).toBe(false);
    expect(
      recordMergeResult(
        { ...reset, project_settings: { merge_gate_enabled: true } },
        system,
        {
          card_id: f.card.id,
          completion_id: completion.id,
          result: {
            kind: "merged",
            merge_sha: "d".repeat(40),
            previous_sha: "b".repeat(40),
            tree_sha: "c".repeat(40),
          },
        },
        f.io,
      ).ok,
    ).toBe(false);
    // A human's current-version pass releases the same system confirmation, without a new question.
    const passed = apply(
      reset,
      value(
        updateCard(
          reset,
          human,
          {
            card_id: f.card.id,
            pre_merge_check: { label: "上线前人工核对", status: "passed" },
          },
          f.io,
        ),
      ),
    );
    expect(mergePlan(passed, f.card.id).ok).toBe(true);
    const ready = apply(
      waiting,
      value(
        updateCard(
          waiting,
          human,
          {
            card_id: f.card.id,
            pre_merge_check: { label: "上线前人工核对", status: "passed" },
          },
          f.io,
        ),
      ),
    );
    expect(confirm(ready, q, f.io).ok).toBe(true);
  },
);

test.each([1, 2, 3])(
  "V-1574: flow %i keeps legacy PM checklist semantics",
  async (flow_version) => {
    const f = mergeFixture();
    await f.accept();
    const state = {
      ...f.state,
      cards: f.state.cards.map((c) => ({ ...c, flow_version })),
    };
    const q = required(state.decisions[0]);
    const updated = apply(
      state,
      value(
        updateCard(
          state,
          human,
          {
            card_id: f.card.id,
            pre_merge_check: { label: "上线前人工核对", status: "pending" },
          },
          f.io,
        ),
      ),
    );
    expect(pmMergeBlockers(updated, q)).toEqual(pmMergeBlockers(state, q));
  },
);
