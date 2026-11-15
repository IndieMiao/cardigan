import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  assign,
  type CommandState,
  createWorkItem,
  type Decision,
  mergePlan,
  pmConfirmRoleRuleImplementations,
  type RoleRuleBasis,
  type RoleRuleInventory,
  recordDecision,
  recordMergeCheck,
  requestDecision,
  resolveDelegatedDecision,
  roleRuleConfirmationRequired,
  roleRuleMergeReason,
  setProjectPreferences,
  standingTools,
  submitReview,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import {
  apply,
  assignment,
  fixture,
  human,
  id,
  ports,
  role,
  value,
} from "./test-fixtures.js";

const { work_item_id: _work, ...base } = assignment(900, "pm");
const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
const opsActor: Actor = {
  kind: "assignment",
  project_id: human.project_id,
  assignment_id: ops.id,
  ...role("pm"),
  allowed_tools: standingTools(role("pm").allowed_tools, "ops"),
};
const system: Actor = { kind: "system", project_id: human.project_id };

/** Real workflow commands; host Git inventory is a synthetic port fixture here. */
async function setup(ruleText = "日志和说明使用中文。") {
  const seed = fixture();
  const f = mergeFixture("confirm", 3, {
    state: {
      ...seed,
      cards: [],
      work_items: [],
      assignments: [ops],
      runs: [],
      roles: [...seed.roles, role("independent_reviewer")],
    },
    ports: ports(),
  });
  const item = f.commit(
    createWorkItem(
      f.state,
      human,
      {
        card_id: f.card.id,
        title: "Independent",
        kind: "verify",
        role_id: "independent_reviewer",
        required: true,
        target_work_item_id: f.coder.work_item_id!,
        completion_criteria: ["Safe"],
      },
      f.io,
    ),
  );
  const reviewer = f.commit(
    assign(
      f.state,
      human,
      { work_item_id: item.id, role_id: item.role_id },
      f.io,
    ),
  );
  const product = await f.deliver();
  f.review(product);
  f.start(reviewer);
  f.commit(
    submitReview(
      f.state,
      f.actor(reviewer),
      {
        delivery_id: product.id,
        target_sha: product.subject.value,
        kind: "code",
        issues: [],
      },
      f.io,
    ),
  );
  const completion = await f.deliver("card_completion");
  f.review(completion);
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { decision_delegation: { feature_detail: false } },
      f.io,
    ),
  );
  const source = f.commit(
    requestDecision(
      f.state,
      human,
      {
        kind: "choose",
        card_id: f.card.id,
        question: "日志语言？",
        context: "Pick wording",
        category: "feature_detail",
        options: [{ key: "chinese", description: "中文", impact: "日志中文" }],
        recommended: "chinese",
        decider: "human",
        blocking: false,
        affected_work_items: [],
        affected_cards: [f.card.id],
        plain_summary: {
          changed: "统一日志语言",
          impact: "日志中文",
          risk: "无",
        },
      },
      f.io,
    ),
  );
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: source.id,
        option: "chinese",
        rationale: ruleText,
        raw_quote: ruleText,
      },
      f.io,
    ),
  );
  const identity = {
    card_id: f.card.id,
    completion_id: completion.id,
    attempt_id: "role-rule-check",
    candidate_sha: "b".repeat(40),
    tree_sha: "c".repeat(40),
  };
  for (const status of ["queued", "running", "passed"] as const)
    f.commit(
      recordMergeCheck(
        { ...f.state, project_settings: { merge_gate_enabled: true } },
        system,
        status !== "passed"
          ? { ...identity, status }
          : {
              ...identity,
              status,
              summary: "pass",
              log_ref: "role-rule-check.log",
              checks: [
                {
                  name: "test",
                  status: "passed",
                  exit_code: 0,
                  duration_ms: 1,
                },
              ],
            },
        f.io,
      ),
    );
  const inventory: RoleRuleInventory = {
    version: 1,
    complete: true,
    base_sha: "d".repeat(40),
    sha: product.subject.value,
    tree_sha: "e".repeat(40),
    changes: [
      {
        id: "AGENTS.md",
        path: "AGENTS.md",
        old_mode: "100644",
        new_mode: "100644",
        old_oid: "1".repeat(40),
        new_oid: "2".repeat(40),
        status: "M",
        category: "body",
        edits: [
          {
            id: "AGENTS.md:@@ -1 +1 @@",
            before: "日志使用中文。",
            after: ruleText,
          },
        ],
      },
    ],
  };
  const state: CommandState = {
    ...f.state,
    deliveries: f.state.deliveries.map((v) =>
      v.id === product.id
        ? {
            ...v,
            evidence: [
              {
                kind: "diff",
                details: {
                  role_rule_inventory: JSON.parse(JSON.stringify(inventory)),
                },
              },
            ],
          }
        : v,
    ),
  };
  const q = state.decisions.findLast(
    (q) => q.trigger === "merge_confirmation",
  )!;
  const basis: RoleRuleBasis = {
    completion_id: completion.id,
    inventories: [
      {
        delivery_id: product.id,
        base_sha: inventory.base_sha,
        sha: inventory.sha,
        tree_sha: inventory.tree_sha,
      },
    ],
    mappings: [
      {
        delivery_id: product.id,
        edit_id: inventory.changes[0]!.edits[0]!.id,
        category: "body",
        decision_id: source.id,
        quote: ruleText,
        explanation: "此处只落实人指定的日志与说明语言。",
      },
    ],
  };
  const resolve = (s = state, b = basis) =>
    resolveDelegatedDecision(
      s,
      opsActor,
      {
        decision_id: q.id,
        option: "merge",
        role_rule_basis: b,
        rationale: "逐处对应人的日志语言决定。",
        notice: "日志与说明使用中文，权限未变。",
      },
      f.io,
    );
  return {
    state,
    f,
    q,
    basis,
    source: state.decisions.find((q) => q.id === source.id)!,
    product,
    completion,
    inventory,
    resolve,
  };
}

test("default-on body exception requires every edit, a formal human answer and current independent review", async () => {
  const x = await setup();
  expect(pmConfirmRoleRuleImplementations()).toBe(true);
  expect(roleRuleMergeReason(x.state, x.q)).toContain("逐处人依据");
  const effect = value(x.resolve());
  expect(effect.data.resolution).toMatchObject({
    via: "delegated",
    resolved_by: `assignment:${ops.id}`,
  });
  expect(effect.data.role_rule_basis).toEqual(x.basis);
  expect(
    effect.events.find((e) => e.type === "decision_resolved")?.payload,
  ).toMatchObject({ role_rule_basis: x.basis });
  expect(mergePlan(apply(x.state, effect), x.f.card.id).ok).toBe(true);
});

test("publication rejects invalid inherited proof even after human role confirmation", async () => {
  const x = await setup();
  const confirmed = apply(
    x.state,
    value(
      recordDecision(
        x.state,
        human,
        {
          decision_id: x.q.id,
          option: "merge",
          rationale: "本人确认角色改动",
          raw_quote: "本人确认角色改动",
        },
        x.f.io,
      ),
    ),
  );
  expect(mergePlan(confirmed, x.f.card.id).ok).toBe(true);
  for (const invalid of [
    { ...confirmed, reviews: [] },
    {
      ...confirmed,
      reviews: confirmed.reviews.map((r) => ({
        ...r,
        withdrawn: { at: x.f.io.clock.now(), rationale: "撤回复核" },
      })),
    },
  ]) {
    const result = mergePlan(
      {
        ...invalid,
        deliveries: invalid.deliveries.map((v) =>
          v.id === x.product.id
            ? {
                ...v,
                reused_reviews: confirmed.reviews
                  .filter((r) => r.delivery_id === v.id)
                  .map((r) => r.id),
              }
            : v,
        ),
      },
      x.f.card.id,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("stale_target");
  }
});

test.each([undefined, "Role authorization changes require human consent"])(
  "suggestion refresh preserves human authority and cannot attach role evidence (%s)",
  async (humanRequiredReason) => {
    const x = await setup();
    const decision = {
      ...x.q,
      decider: "human" as const,
      ...(humanRequiredReason
        ? { human_required_reason: humanRequiredReason }
        : {}),
    };
    const state = {
      ...x.state,
      decisions: x.state.decisions.map((q) =>
        q.id === decision.id ? decision : q,
      ),
    };
    const params = {
      decision_id: decision.id,
      option: "merge",
      rationale: "Reviewed the current role evidence for the human",
      escalate: true,
      suggestion: {
        option: "merge",
        rationale: "Human review is still required",
      },
    };
    const effect = value(
      resolveDelegatedDecision(state, opsActor, params, x.f.io),
    );
    const updated = apply(state, effect).decisions.find(
      (q) => q.id === decision.id,
    )!;
    const { suggestion, recommended, ...authority } = updated;
    const {
      suggestion: _oldSuggestion,
      recommended: _oldRecommended,
      ...originalAuthority
    } = decision;
    expect(authority).toEqual(originalAuthority);
    expect(suggestion?.option).toBe("merge");
    expect(recommended).toBe("merge");
    expect(effect.events.some((e) => e.type === "decision_resolved")).toBe(
      false,
    );
    expect(mergePlan(apply(state, effect), x.f.card.id).ok).toBe(false);
    expect(
      resolveDelegatedDecision(
        state,
        opsActor,
        { ...params, role_rule_basis: x.basis },
        x.f.io,
      ).ok,
    ).toBe(false);
  },
);

test("missing, extra, duplicate, wrong completion/SHA/tree/base mappings reject", async () => {
  const x = await setup();
  for (const basis of [
    { ...x.basis, mappings: [] },
    { ...x.basis, mappings: [...x.basis.mappings, ...x.basis.mappings] },
    { ...x.basis, completion_id: id("delivery", 999) },
    ...["sha", "tree_sha", "base_sha"].map((k) => ({
      ...x.basis,
      inventories: x.basis.inventories.map((i) => ({
        ...i,
        [k]: "f".repeat(40),
      })),
    })),
  ])
    expect(x.resolve(x.state, basis).ok).toBe(false);
  expect(
    x.resolve({
      ...x.state,
      reviews: x.state.reviews.filter(
        (r) =>
          r.work_item_id !==
          x.f.state.work_items.find(
            (w) => w.role_id === "independent_reviewer",
          )!.id,
      ),
    }).ok,
  ).toBe(false);
});

test.each(["forbidden", "unknown"] as const)(
  "tools, capabilities, isolation, review and PM self-authorization (%s) stay human",
  async (category) => {
    const x = await setup();
    const s = {
      ...x.state,
      deliveries: x.state.deliveries.map((v) =>
        v.id === x.product.id
          ? {
              ...v,
              evidence: [
                {
                  kind: "diff" as const,
                  details: {
                    role_rule_inventory: JSON.parse(
                      JSON.stringify({
                        ...x.inventory,
                        changes: x.inventory.changes.map((c) => ({
                          ...c,
                          category,
                        })),
                      }),
                    ),
                  },
                },
              ],
            }
          : v,
      ),
    };
    expect(x.resolve(s).ok).toBe(false);
  },
);

test("PM-written quotes, Office transcriptions, missing audit and withdrawn answers cannot prove human authority", async () => {
  const x = await setup();
  for (const patch of [
    { status: "withdrawn" as const },
    {
      resolution: {
        ...x.source.resolution!,
        resolved_by: `assignment:${ops.id}` as const,
      },
    },
    {
      resolution: {
        ...x.source.resolution!,
        resolved_by: "human" as const,
        via: "pm_office_chat" as const,
        via_chain: ["human" as const, `assignment:${ops.id}` as const],
      },
    },
  ]) {
    const state = {
      ...x.state,
      decisions: x.state.decisions.map((q) =>
        q.id === x.source.id ? ({ ...q, ...patch } as Decision) : q,
      ),
    };
    expect(x.resolve(state).ok).toBe(false);
  }
  expect(
    x.resolve({
      ...x.state,
      events: x.state.events.filter((e) => e.type !== "decision_resolved"),
    }).ok,
  ).toBe(false);
  expect(
    x.resolve(x.state, {
      ...x.basis,
      mappings: x.basis.mappings.map((m) => ({
        ...m,
        quote: "PM自己写的原话",
      })),
    }).ok,
  ).toBe(false);
});

test("switch-off restores Q-279; pending/answered proxies lose authority, human consent survives", async () => {
  const x = await setup();
  const confirmed = apply(x.state, value(x.resolve()));
  const disabled = apply(
    confirmed,
    value(
      setProjectPreferences(
        confirmed,
        human,
        { pm_confirm_role_rule_implementations: false },
        x.f.io,
      ),
    ),
  );
  expect(disabled.decisions.find((q) => q.id === x.q.id)?.status).toBe(
    "superseded",
  );
  expect(
    disabled.decisions.findLast((q) => q.trigger === "merge_confirmation")
      ?.decider,
  ).toBe("human");
  expect(mergePlan(disabled, x.f.card.id).ok).toBe(false);
  const enabled = apply(
    disabled,
    value(
      setProjectPreferences(
        disabled,
        human,
        { pm_confirm_role_rule_implementations: true },
        x.f.io,
      ),
    ),
  );
  expect(mergePlan(enabled, x.f.card.id).ok).toBe(false);
  const off = {
    ...x.state,
    project_preferences: [
      {
        id: x.state.project_id,
        auto_merge_after_minutes: null,
        pm_confirm_role_rule_implementations: false,
      },
    ],
  };
  expect(roleRuleMergeReason(off, x.q)).toBe("角色规则改动按 Q-279 由人确认。");
  expect(x.resolve(off).ok).toBe(false);
  const humanState = apply(
    x.state,
    value(
      recordDecision(
        x.state,
        human,
        {
          decision_id: x.q.id,
          option: "merge",
          rationale: "本人确认",
          raw_quote: "本人确认",
        },
        x.f.io,
      ),
    ),
  );
  expect(
    mergePlan(
      { ...humanState, project_preferences: off.project_preferences },
      x.f.card.id,
    ).ok,
  ).toBe(true);
});

test("publication rechecks source, inventory and independent review even after a PM answered", async () => {
  const x = await setup();
  const s = apply(x.state, value(x.resolve()));
  for (const changed of [
    {
      ...s,
      decisions: s.decisions.map((q) =>
        q.id === x.source.id ? { ...q, status: "withdrawn" as const } : q,
      ),
    },
    {
      ...s,
      deliveries: s.deliveries.map((v) =>
        v.id === x.product.id
          ? {
              ...v,
              subject: { kind: "git_head" as const, value: "f".repeat(40) },
            }
          : v,
      ),
    },
    { ...s, reviews: [] },
  ])
    expect(mergePlan(changed, x.f.card.id).ok).toBe(false);
});

test("other forced-human reasons and global merge switch cannot be overridden by a role mapping", async () => {
  const x = await setup();
  for (const s of [
    {
      ...x.state,
      cards: x.state.cards.map((c) => ({ ...c, sensitive: true })),
    },
    {
      ...x.state,
      decisions: x.state.decisions.map((q) =>
        q.id === x.q.id ? { ...q, human_required_reason: "人亲自确认" } : q,
      ),
    },
    {
      ...x.state,
      project_preferences: [
        {
          id: x.state.project_id,
          auto_merge_after_minutes: null,
          pm_merge_confirmation: false,
        },
      ],
    },
    {
      ...x.state,
      decisions: x.state.decisions.map((q) =>
        q.id === x.source.id ? { ...q, category: "permission" as const } : q,
      ),
    },
  ])
    expect(x.resolve(s).ok).toBe(false);
});

test("Agent and PM tokens cannot change the preference", async () => {
  const x = await setup();
  for (const actor of [opsActor, x.f.actor(x.f.coder)])
    expect(
      setProjectPreferences(
        x.state,
        actor,
        { pm_confirm_role_rule_implementations: false },
        x.f.io,
      ).ok,
    ).toBe(false);
});

test("auto templates cannot publish role changes without current consent or rely on a vanished inventory", async () => {
  const x = await setup();
  const auto = {
    ...x.state,
    cards: x.state.cards.map((c) => ({ ...c, merge_policy: "auto" as const })),
    decisions: x.state.decisions.filter((q) => q.id !== x.q.id),
  };
  expect(mergePlan(auto, x.f.card.id).ok).toBe(false);
  const missing = {
    ...x.state,
    deliveries: x.state.deliveries.map((v) =>
      v.id === x.product.id ? { ...v, evidence: [] } : v,
    ),
  };
  expect(x.resolve(missing).ok).toBe(false);
});

test.each([true, false])(
  "ordinary facts preserve confirm, auto and risk routes with role preference %s",
  async (enabled) => {
    const x = await setup();
    const ordinary: CommandState = {
      ...x.state,
      project_preferences: [
        {
          id: x.state.project_id,
          auto_merge_after_minutes: null,
          pm_confirm_role_rule_implementations: enabled,
        },
      ],
      deliveries: x.state.deliveries.map((v) =>
        v.id === x.product.id
          ? {
              ...v,
              evidence: [
                {
                  kind: "diff",
                  details: {
                    role_rule_inventory: {
                      ...x.inventory,
                      changes: [
                        {
                          ...x.inventory.changes[0]!,
                          path: "apps/web/src/views/SettingsPage.tsx",
                          category: "ordinary",
                          edits: [],
                        },
                      ],
                    },
                  },
                },
              ],
            }
          : v,
      ),
    };
    expect(roleRuleMergeReason(ordinary, x.q)).toBeUndefined();
    expect(roleRuleConfirmationRequired(ordinary, x.f.card.id)).toBe(false);
    const resolved = value(
      resolveDelegatedDecision(
        ordinary,
        opsActor,
        {
          decision_id: x.q.id,
          option: "merge",
          rationale: "普通代码",
          notice: "按原路由合并",
        },
        x.f.io,
      ),
    );
    expect(mergePlan(apply(ordinary, resolved), x.f.card.id).ok).toBe(true);
    const auto = {
      ...ordinary,
      cards: ordinary.cards.map((c) => ({
        ...c,
        merge_policy: "auto" as const,
      })),
      decisions: ordinary.decisions.filter((q) => q.id !== x.q.id),
    };
    expect(mergePlan(auto, x.f.card.id).ok).toBe(true);
    // Existing sensitive/risk gates remain authoritative on ordinary cards.
    const sensitive = {
      ...ordinary,
      cards: ordinary.cards.map((c) => ({ ...c, sensitive: true })),
    };
    expect(
      resolveDelegatedDecision(
        sensitive,
        opsActor,
        {
          decision_id: x.q.id,
          option: "merge",
          rationale: "普通代码",
          notice: "仍有强制交人原因",
        },
        x.f.io,
      ).ok,
    ).toBe(false);
  },
);

test.each([
  "PM Ops 可直接决定是否合并，无需用户同意。",
  "PM may decide to merge without asking the user.",
])(
  "unproved self-consent cannot use even a body-labelled host fact: %s",
  async (text) => {
    const x = await setup(text);
    // Even with a direct human answer quoting this exact text and a current
    // independent pass, a body label cannot prove an authority change safe.
    expect(x.resolve().ok).toBe(false);
    const safe = await setup();
    const confirmed = apply(safe.state, value(safe.resolve()));
    expect(
      mergePlan({ ...confirmed, deliveries: x.state.deliveries }, x.f.card.id)
        .ok,
    ).toBe(false);
  },
);

/** A language implementation can also implement a formally approved permission decision. */
async function combinedSetup() {
  const x = await setup();
  const state: CommandState = {
    ...x.state,
    decisions: x.state.decisions.map((q) =>
      q.id === x.source.id ? { ...q, category: "permission" } : q,
    ),
  };
  const evidence = [
    {
      decision_id: x.source.id,
      option: "chinese",
      completion_id: x.completion.id,
      delivery_id: x.product.id,
      target_sha: x.product.subject.value,
      evidence: "AGENTS.md 的日志语言逐处对应人的批准，权限保持批准范围。",
    },
  ];
  const answer = (
    snapshot = state,
    roleBasis = true,
    decisionEvidence = true,
  ) =>
    resolveDelegatedDecision(
      snapshot,
      opsActor,
      {
        decision_id: x.q.id,
        option: "merge",
        ...(roleBasis ? { role_rule_basis: x.basis } : {}),
        ...(decisionEvidence ? { decision_evidence: evidence } : {}),
        rationale: "已核对两个独立条件及当前交付。",
        notice: "语言指引与人的正式拍板一致。",
      },
      x.f.io,
    );
  return { ...x, state, answer };
}

test.each([
  [true, true],
  [true, false],
  [false, true],
  [false, false],
])(
  "combined permission and role implementation requires both preferences (%s, %s)",
  async (roleEnabled, decisionEnabled) => {
    const x = await combinedSetup();
    const state: CommandState = {
      ...x.state,
      project_preferences: [
        {
          id: x.state.project_id,
          auto_merge_after_minutes: null,
          pm_confirm_role_rule_implementations: roleEnabled,
          pm_confirm_human_decided_merges: decisionEnabled,
        },
      ],
    };
    const result = x.answer(state);
    expect(result.ok).toBe(roleEnabled && decisionEnabled);
    if (result.ok)
      expect(mergePlan(apply(state, result.value), x.f.card.id).ok).toBe(true);
  },
);

test("combined exceptions require both evidence contracts and preserve forced-human reasons", async () => {
  const x = await combinedSetup();
  expect(x.answer(x.state, false, true).ok).toBe(false);
  expect(x.answer(x.state, true, false).ok).toBe(false);
  for (const state of [
    {
      ...x.state,
      cards: x.state.cards.map((c) => ({ ...c, sensitive: true })),
    },
    {
      ...x.state,
      decisions: x.state.decisions.map((q) =>
        q.id === x.q.id ? { ...q, human_required_reason: "人须亲自确认" } : q,
      ),
    },
    {
      ...x.state,
      project_preferences: [
        {
          id: x.state.project_id,
          auto_merge_after_minutes: null,
          pm_merge_confirmation: false,
        },
      ],
    },
  ])
    expect(x.answer(state).ok).toBe(false);
});

test("combined publication rechecks both preferences and sources; toggling cannot revive proxy consent", async () => {
  const x = await combinedSetup();
  const confirmed = apply(x.state, value(x.answer()));
  for (const preference of [
    "pm_confirm_role_rule_implementations",
    "pm_confirm_human_decided_merges",
  ] as const) {
    const disabled = apply(
      confirmed,
      value(
        setProjectPreferences(
          confirmed,
          human,
          { [preference]: false },
          x.f.io,
        ),
      ),
    );
    expect(disabled.decisions.find((q) => q.id === x.q.id)?.status).toBe(
      "superseded",
    );
    expect(mergePlan(disabled, x.f.card.id).ok).toBe(false);
    const enabled = apply(
      disabled,
      value(
        setProjectPreferences(disabled, human, { [preference]: true }, x.f.io),
      ),
    );
    expect(mergePlan(enabled, x.f.card.id).ok).toBe(false);
  }
  const withdrawn: CommandState = {
    ...confirmed,
    decisions: confirmed.decisions.map((q) =>
      q.id === x.source.id ? { ...q, status: "withdrawn" } : q,
    ),
  };
  expect(mergePlan(withdrawn, x.f.card.id).ok).toBe(false);
});
