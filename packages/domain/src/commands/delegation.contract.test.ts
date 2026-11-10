import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  autoConfirmMerge,
  type CommandEffect,
  type CommandState,
  type DecisionCategory,
  decisionCategories,
  decisionDelegation,
  decisionFollowupBlocked,
  decisionFollowupPrompt,
  decisionHistory,
  developmentCardTemplate,
  listNeedsYou,
  pauseStandingAssignment,
  postComment,
  prepareDelivery,
  projectPreferences,
  type Result,
  recordDecision,
  releaseAssignment,
  remindDecisionFollowups,
  requestDecision,
  requestHumanAction,
  resolveDelegatedDecision,
  setProjectPreferences,
  standingTools,
  submitDelivery,
  triageHumanAction,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  id,
  now,
  ports,
  role,
  value,
} from "./test-fixtures.js";

function setup(active = true) {
  let state = fixture();
  const io = ports();
  const { work_item_id: _work, ...base } = assignment(4, "pm");
  const ops: Assignment = {
    ...base,
    scope: "standing",
    standing_mode: "ops",
    status: active ? "active" : "suspended",
  };
  const office: Assignment = {
    ...base,
    id: id("assignment", 5),
    scope: "standing",
    standing_mode: "office",
  };
  state = {
    ...state,
    assignments: [
      ...state.assignments.filter((a) => a.id !== ops.id),
      ops,
      office,
    ],
  };
  const identity = (a: Assignment): Actor => ({
    kind: "assignment",
    project_id: human.project_id,
    assignment_id: a.id,
    ...role("pm"),
    allowed_tools: standingTools(
      role("pm").allowed_tools,
      a.standing_mode ?? "ops",
    ),
  });
  function commit<T>(result: Result<CommandEffect<T>>) {
    const effect = value(result);
    state = apply(state, effect);
    return effect.data;
  }
  const request = (category: DecisionCategory = "general", card = true) =>
    commit(
      requestDecision(
        state,
        card ? actor() : identity(office),
        {
          ...(card ? { card_id: id("card", 1) } : {}),
          category,
          kind: "choose",
          question: "继续处理？",
          context: "已核实可选方案",
          options: [
            {
              key: "continue",
              description: "继续实施",
              impact: "安排下一步工作",
            },
          ],
          recommended: "continue",
          affected_cards: card ? [id("card", 1)] : [],
          affected_work_items: [],
          blocking: false,
          decider: "human",
        },
        io,
      ),
    );
  const humanResolve = (
    decision_id: ReturnType<typeof request>["id"],
    delegate_future = false,
  ) =>
    recordDecision(
      state,
      human,
      {
        decision_id,
        option: "continue",
        rationale: "确认",
        raw_quote: "继续",
        delegate_future,
      },
      { ...io, human_confirmation: "workbench" },
    );
  return {
    get state() {
      return state;
    },
    io,
    ops,
    office,
    pm: identity(ops),
    front: identity(office),
    commit,
    request,
    humanResolve,
  };
}

test.each(decisionCategories)(
  "category %s routes by authorization and rejects Office high-risk transcription",
  (category) => {
    const f = setup();
    const q = f.request(category);
    const delegated = ["general", "feature_detail"].includes(category);
    expect(q.decider).toBe(delegated ? "role:pm" : "human");
    expect(
      value(listNeedsYou(f.state, human)).data.decisions.map((q) => q.id),
    ).toEqual(delegated ? [] : [q.id]);
    expect(
      value(listNeedsYou(f.state, f.pm)).data.pm_queue?.decisions.map(
        (q) => q.id,
      ),
    ).toEqual(delegated ? [q.id] : []);
    expect(
      recordDecision(
        f.state,
        f.front,
        {
          decision_id: q.id,
          option: "continue",
          rationale: "转录",
          raw_quote: "同意",
        },
        f.io,
      ).ok,
    ).toBe(false);
    const answer = resolveDelegatedDecision(
      f.state,
      f.pm,
      {
        decision_id: q.id,
        option: "continue",
        rationale: "符合授权，继续实施",
      },
      f.io,
    );
    expect(answer.ok).toBe(delegated);
    if (delegated) {
      const resolved = f.commit(answer);
      expect(resolved.resolution).toMatchObject({
        via: "delegated",
        resolved_by: "assignment:A-4",
        rationale: "符合授权，继续实施",
        proxy_authority: expect.stringContaining(category),
      });
    } else {
      expect(
        recordDecision(
          f.state,
          human,
          {
            decision_id: q.id,
            option: "continue",
            rationale: "确认",
            raw_quote: "继续",
          },
          f.io,
        ).ok,
      ).toBe(false);
      expect(f.commit(f.humanResolve(q.id)).status).toBe("resolved");
    }
  },
);

test.each(decisionCategories)(
  "without active Ops, %s is human-owned",
  (category) => {
    expect(setup(false).request(category).decider).toBe("human");
  },
);

test("human grant is atomic with the answer, audited, and effective on the next decision", () => {
  const f = setup();
  const q = f.request("scope_change");
  const invalid = recordDecision(
    f.state,
    human,
    {
      decision_id: q.id,
      option: "missing",
      rationale: "确认",
      raw_quote: "确认",
      delegate_future: true,
    },
    { ...f.io, human_confirmation: "workbench" },
  );
  expect(invalid.ok).toBe(false);
  expect(decisionDelegation(projectPreferences(f.state)).scope_change).toBe(
    false,
  );
  f.commit(f.humanResolve(q.id, true));
  expect(decisionDelegation(projectPreferences(f.state)).scope_change).toBe(
    true,
  );
  expect(
    f.state.events.filter((e) => e.type === "project_preferences_updated"),
  ).toMatchObject([
    {
      actor: human,
      payload: { decision_id: q.id, preference: "decision_delegation" },
    },
  ]);
  expect(f.request("scope_change").decider).toBe("role:pm");
});

test.each(["spending", "account", "permission", "data_deletion"] as const)(
  "%s cannot be granted in settings or with a decision",
  (category) => {
    const f = setup();
    const q = f.request(category);
    for (const enabled of [true, false])
      expect(
        setProjectPreferences(
          f.state,
          human,
          { decision_delegation: { [category]: enabled } },
          f.io,
        ).ok,
      ).toBe(false);
    expect(f.humanResolve(q.id, true).ok).toBe(false);
    expect(f.state.decisions[0]?.status).toBe("open");
  },
);

test("revocation immediately hands pending decisions to humans and preserves merge preference", () => {
  const f = setup();
  const q = f.request();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { auto_merge_after_minutes: 12 },
      f.io,
    ),
  );
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { decision_delegation: { general: false } },
      f.io,
    ),
  );
  expect(projectPreferences(f.state).auto_merge_after_minutes).toBe(12);
  expect(f.state.decisions.find((d) => d.id === q.id)?.decider).toBe("human");
  expect(f.request().decider).toBe("human");
  expect(
    resolveDelegatedDecision(
      f.state,
      f.pm,
      { decision_id: q.id, option: "continue", rationale: "过期授权" },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    setProjectPreferences(
      f.state,
      f.pm,
      { decision_delegation: { general: true } },
      f.io,
    ).ok,
  ).toBe(false);
});

test.each(["pause", "release"])(
  "%s of the last Ops hands off decisions and untriaged actions",
  (operation) => {
    const f = setup();
    const q = f.request("feature_detail");
    const action = f.commit(
      requestHumanAction(
        f.state,
        actor(),
        {
          card_id: id("card", 1),
          instructions: "同步 Git 基线",
          why_human: "主机持有凭据",
          expected_return: "基线 SHA",
          blocked_work_items: [],
        },
        f.io,
      ),
    );
    expect(action.triage).toBe("pm_ops");
    expect(value(listNeedsYou(f.state, human)).data.human_actions).toHaveLength(
      0,
    );
    if (operation === "pause")
      f.commit(
        pauseStandingAssignment(
          f.state,
          human,
          { assignment_id: f.ops.id },
          f.io,
        ),
      );
    else
      f.commit(
        releaseAssignment(f.state, human, { assignment_id: f.ops.id }, f.io),
      );
    expect(f.state.decisions.find((d) => d.id === q.id)?.decider).toBe("human");
    expect(
      value(listNeedsYou(f.state, human)).data.human_actions[0]?.triage,
    ).toBe("human");
  },
);

test.each(["done", "host", "human"] as const)(
  "Ops triage %s records result or clear handoff steps without escalating first",
  (disposition) => {
    const f = setup();
    const action = f.commit(
      requestHumanAction(
        f.state,
        actor(),
        {
          card_id: id("card", 1),
          instructions: "请处理",
          why_human: "权限",
          expected_return: "结果",
          blocked_work_items: [id("work_item", 1)],
        },
        f.io,
      ),
    );
    const params = {
      human_action_id: action.id,
      disposition,
      rationale: "核实权限后处理",
      instructions: "在主机同步基线",
      expected_return: "回传 SHA",
    };
    expect(triageHumanAction(f.state, f.front, params, f.io).ok).toBe(false);
    const result = f.commit(triageHumanAction(f.state, f.pm, params, f.io));
    expect(result.status).toBe(disposition === "done" ? "done" : "open");
    if (disposition === "done") {
      expect(result.result?.text).toBe(params.rationale);
      expect(
        f.state.work_items.find((w) => w.id === id("work_item", 1))?.status,
      ).toBe("in_progress");
    } else {
      expect(
        value(listNeedsYou(f.state, human)).data.human_actions[0],
      ).toMatchObject({
        triage: disposition,
        instructions: params.instructions,
        expected_return: params.expected_return,
      });
    }
  },
);

test("project decisions appear in the Ops queue, can be escalated, and need a nonblank rationale", () => {
  const f = setup();
  const q = f.request("feature_detail", false);
  const params = { decision_id: q.id, option: "continue", rationale: " " };
  expect(resolveDelegatedDecision(f.state, f.pm, params, f.io).ok).toBe(false);
  const next = f.commit(
    resolveDelegatedDecision(
      f.state,
      f.pm,
      { ...params, rationale: "实际影响已超出授权", escalate: true },
      f.io,
    ),
  );
  expect(next.decider).toBe("human");
  expect(next.status).toBe("open");
  expect(value(listNeedsYou(f.state, human)).data.decisions[0]?.id).toBe(q.id);
});

test.each(["human", "pm"] as const)(
  "%s resolution supplies first-prompt instructions and one timeout reminder until implementation is recorded",
  (mode) => {
    const f = setup(mode === "pm");
    const q = f.request();
    if (mode === "human") f.commit(f.humanResolve(q.id));
    else
      f.commit(
        resolveDelegatedDecision(
          f.state,
          f.pm,
          { decision_id: q.id, option: "continue", rationale: "继续" },
          f.io,
        ),
      );
    expect(
      decisionFollowupPrompt(
        f.state,
        f.state.events.map((e) => e.id),
        "A-1",
      ),
    ).toContain("影响：安排下一步工作");
    const later = (minutes: number) => ({
      ...f.io,
      clock: {
        now: () => new Date(Date.parse(now) + minutes * 60_000).toISOString(),
      },
    });
    const system = { kind: "system" as const, project_id: f.state.project_id };
    expect(
      value(remindDecisionFollowups(f.state, system, later(29))).events,
    ).toHaveLength(0);
    // ACKs and unrelated conversation are not evidence of implementation.
    f.commit(
      postComment(
        f.state,
        actor(),
        { card_id: id("card", 1), body: "收到，正在处理另一件事" },
        later(10),
      ),
    );
    const before = f.state;
    expect(
      f.commit(remindDecisionFollowups(f.state, system, later(30))),
    ).toEqual([q.id]);
    expect(
      value(remindDecisionFollowups(f.state, system, later(60))).events,
    ).toHaveLength(0);
    const recorded = apply(
      before,
      value(
        postComment(
          before,
          actor(),
          {
            card_id: id("card", 1),
            body: `${q.id} 执行结果：已安排下一步工作`,
          },
          later(20),
        ),
      ),
    );
    expect(
      value(remindDecisionFollowups(recorded, system, later(30))).events,
    ).toHaveLength(0);
    expect(
      decisionHistory(f.state, {
        decider: mode,
        category: "general",
        card_id: "C-1",
        from: now,
        to: now,
      }),
    ).toHaveLength(1);
    expect(decisionHistory(f.state, { decider: "system" })).toHaveLength(0);
  },
);

test("legacy PM roles lacking the new tools fall back to humans without changing role versions", () => {
  const f = setup();
  const seed = f.request();
  const legacy = {
    ...f.state,
    roles: f.state.roles.map((r) => ({
      ...r,
      allowed_tools: r.allowed_tools.filter(
        (t) =>
          t !== "resolve_delegated_decision" && t !== "triage_human_action",
      ),
    })),
  };
  const next = value(
    requestDecision(legacy, actor(), { ...seed, category: "general" }, f.io),
  ).data;
  expect(next.decider).toBe("human");
  const action = value(
    requestHumanAction(
      legacy,
      actor(),
      {
        card_id: id("card", 1),
        instructions: "提供副本",
        why_human: "主机操作",
        expected_return: "路径",
        blocked_work_items: [],
      },
      f.io,
    ),
  ).data;
  expect(action.triage).toBe("human");
  expect(legacy.assignments).toEqual(f.state.assignments);
});

test("implementation notifications do not start a work-item Run until its final blocker is resolved", () => {
  const f = setup();
  const seed = f.request();
  const first = f.commit(
    requestDecision(
      f.state,
      actor(),
      { ...seed, category: "general", blocking: true },
      f.io,
    ),
  );
  const second = f.commit(
    requestDecision(
      f.state,
      f.front,
      {
        ...seed,
        category: "permission",
        decider: "human",
        blocking: true,
        affected_work_items: [id("work_item", 1)],
      },
      f.io,
    ),
  );
  f.commit(
    resolveDelegatedDecision(
      f.state,
      f.pm,
      { decision_id: first.id, option: "continue", rationale: "按授权处理" },
      f.io,
    ),
  );
  const fact = f.state.events.find((e) => e.type === "decision_resolved");
  if (!fact) throw new Error("Missing resolution");
  expect(fact.payload).toMatchObject({
    option_description: "继续实施",
    impact: "安排下一步工作",
    raised_by: "assignment:A-1",
  });
  expect(decisionFollowupBlocked(f.state, fact.id, "A-1")).toBe(true);
  expect(f.state.runs.filter((r) => r.status === "queued")).toHaveLength(0);
  f.commit(f.humanResolve(second.id));
  expect(decisionFollowupBlocked(f.state, fact.id, "A-1")).toBe(false);
  expect(f.state.runs.filter((r) => r.status === "queued")).toHaveLength(1);
});

test("history distinguishes system auto-approval from PM and keeps a resolved decision after supersession", async () => {
  const f = mergeFixture();
  await f.accept();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { auto_merge_after_minutes: 1 },
      f.io,
    ),
  );
  const q = f.state.decisions[0];
  if (!q) throw new Error("Missing merge confirmation");
  f.commit(
    autoConfirmMerge(
      f.state,
      { kind: "system", project_id: f.state.project_id },
      { decision_id: q.id },
      {
        ...f.io,
        clock: { now: () => new Date(Date.parse(now) + 60_000).toISOString() },
      },
    ),
  );
  expect(decisionHistory(f.state, { decider: "system" })).toMatchObject([
    {
      id: q.id,
      resolution: {
        via: "delegated",
        resolved_by: "system",
        proxy_authority: expect.any(String),
      },
    },
  ]);
  expect(decisionHistory(f.state, { decider: "pm" })).toEqual([]);
  const superseded = {
    ...f.state,
    decisions: f.state.decisions.map((q) => ({
      ...q,
      status: "superseded" as const,
    })),
  };
  expect(decisionHistory(superseded, { decider: "system" })).toHaveLength(1);
});

test.each([true, false])(
  "delegated completion preserves employee separation (same employee=%s)",
  async (sameEmployee) => {
    const f = setup();
    const template = {
      ...developmentCardTemplate,
      id: "human-acceptance",
      builtin: false,
      merge: "none" as const,
      requires_repo: false,
      completion: { mode: "review" as const, reviewer: "human" as const },
      work_items: [{ ...developmentCardTemplate.work_items[0], role_id: "pm" }],
    };
    let state: CommandState = {
      ...f.state,
      card_templates: [template],
      cards: f.state.cards.map((c) => ({
        ...c,
        template: template.id,
        template_version: 1,
      })),
      work_items: f.state.work_items
        .filter((w) => w.kind === "produce")
        .map((w) => ({ ...w, role_id: "pm" })),
      assignments: f.state.assignments.map((a) =>
        a.id === id("assignment", 1)
          ? { ...a, role_id: "pm", employee_id: id("employee", 1) }
          : a.id === f.ops.id
            ? { ...a, employee_id: id("employee", sameEmployee ? 1 : 2) }
            : a,
      ),
    };
    const product = {
      work_item_id: id("work_item", 1),
      kind: "doc" as const,
      summary: "已完成",
      subject: { kind: "doc_version" as const, value: "v1" },
      requested_verifiers: [],
    };
    for (const kind of ["doc", "card_completion"] as const) {
      const params = { ...product, kind };
      const verified = value(
        await prepareDelivery(state, actor(1, "pm"), params, {
          verify: async () => ({ ok: true, value: [] }),
        }),
      );
      const effect = value(
        submitDelivery(state, actor(1, "pm"), params, verified, f.io),
      );
      state = apply(state, effect);
    }
    const q = state.decisions.at(-1);
    if (!q) throw new Error("Missing completion decision");
    expect(q).toMatchObject({
      trigger: "completion_review",
      category: "feature_detail",
      decider: "role:pm",
    });
    const result = resolveDelegatedDecision(
      state,
      f.pm,
      { decision_id: q.id, option: "approve", rationale: "已核对完成申请" },
      f.io,
    );
    expect(result.ok).toBe(!sameEmployee);
    if (sameEmployee)
      expect(result).toMatchObject({ error: { code: "unauthorized" } });
  },
);

test("unclaimed decisions and overdue follow-ups remain visible without Ops until implementation is recorded", () => {
  const f = setup(false);
  const q = f.request();
  f.commit(f.humanResolve(q.id));
  expect(value(listNeedsYou(f.state, human)).data.decisions).toHaveLength(0);
  const unavailable = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === id("assignment", 1) ? { ...a, status: "released" as const } : a,
    ),
  };
  expect(value(listNeedsYou(unavailable, human)).data.decisions).toMatchObject([
    { id: q.id, status: "resolved", followup_notice: expect.any(String) },
  ]);
  const later = {
    ...f.io,
    clock: { now: () => new Date(Date.parse(now) + 31 * 60_000).toISOString() },
  };
  f.commit(
    remindDecisionFollowups(
      f.state,
      { kind: "system", project_id: f.state.project_id },
      later,
    ),
  );
  const needs = value(listNeedsYou(f.state, human));
  expect(needs.data.decisions).toMatchObject([
    {
      id: q.id,
      status: "resolved",
      followup_notice: expect.any(String),
      resolution: { option: "continue" },
    },
  ]);
  expect(needs.events).toEqual([]);
  const withOps = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === f.ops.id ? { ...a, status: "active" as const } : a,
    ),
  };
  expect(value(listNeedsYou(withOps, human)).data.decisions).toHaveLength(0);
  f.commit(
    postComment(
      f.state,
      human,
      { card_id: id("card", 1), body: `${q.id} 执行结果：已安排后续工作` },
      later,
    ),
  );
  expect(value(listNeedsYou(f.state, human)).data.decisions).toHaveLength(0);
});

test("merged HumanAction query hides untriaged requests and retains C-41's unclaimed completion notice", () => {
  const f = setup();
  const params = {
    card_id: id("card", 1),
    instructions: "提供数据副本",
    why_human: "主机权限",
    expected_return: "路径",
    blocked_work_items: [],
  };
  const action = f.commit(requestHumanAction(f.state, actor(), params, f.io));
  f.commit(
    triageHumanAction(
      f.state,
      f.pm,
      { human_action_id: action.id, disposition: "done", rationale: "已完成" },
      f.io,
    ),
  );
  const pending = f.commit(requestHumanAction(f.state, actor(), params, f.io));
  const noOwners = {
    ...f.state,
    assignments: f.state.assignments.map((a) =>
      a.id === id("assignment", 1) || a.id === f.ops.id
        ? { ...a, status: "released" as const }
        : a,
    ),
  };
  const needs = value(listNeedsYou(noOwners, human)).data.human_actions;
  expect(needs).toMatchObject([{ id: action.id, completion_notice: "已完成" }]);
  expect(needs.some((h) => h.id === pending.id)).toBe(false);
});
