import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  autoConfirmMerge,
  autoMergeSchedule,
  type CardId,
  type CommandState,
  type Decision,
  type DecisionCategory,
  expireMergeSnoozes,
  listNeedsYou,
  type MergeCheckView,
  markNoticesRead,
  mergePlan,
  mergeRequiresHuman,
  notices,
  pmMergeBlockers,
  projectPreferences,
  type RequestDecisionParams,
  recheckMerge,
  recordDecision,
  recordMergeCheck,
  recordMergeResult,
  requestDecision,
  requestMerge,
  resolveDelegatedDecision,
  setCardSensitive,
  setProjectPreferences,
  standingTools,
  type WorkItem,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import {
  assignment,
  human,
  id,
  now,
  ports,
  role,
  value,
} from "./test-fixtures.js";

const TEST_PLAIN_SUMMARY = {
  changed: "测试用的改动说明",
  impact: "测试用的影响说明",
  risk: "无",
};

const system: Actor = { kind: "system", project_id: human.project_id };
const { work_item_id: _work, ...base } = assignment(900, "pm");
const ops: Assignment = {
  ...base,
  scope: "standing",
  standing_mode: "ops",
};
const opsActor: Actor = {
  kind: "assignment",
  project_id: human.project_id,
  assignment_id: ops.id,
  ...role("pm"),
  allowed_tools: standingTools(role("pm").allowed_tools, "ops"),
};

const office: Assignment = {
  ...base,
  id: id("assignment", 901),
  scope: "standing",
  standing_mode: "office",
};
const officeActor: Actor = {
  kind: "assignment",
  project_id: human.project_id,
  assignment_id: office.id,
  ...role("pm"),
  allowed_tools: standingTools(role("pm").allowed_tools, "office"),
};

function setup(withOps = true, policy: "confirm" | "auto" = "confirm") {
  const empty: CommandState = {
    project_id: human.project_id,
    roles: [role("coder"), role("reviewer"), role("pm")],
    cards: [],
    work_items: [],
    assignments: withOps ? [ops, office] : [office],
    runs: [],
    deliveries: [],
    reviews: [],
    decisions: [],
    human_actions: [],
    attachments: [],
    cursors: [],
    timeline: [],
    events: [],
  };
  const f = mergeFixture(policy, 3, { state: empty, ports: ports() });
  const confirmation = () => {
    const q = f.state.decisions
      .filter((q) => q.trigger === "merge_confirmation")
      .at(-1);
    if (!q) throw new Error("Missing merge confirmation");
    return q;
  };
  const check = (
    status: Exclude<MergeCheckView["status"], "executor_unreachable">,
    attempt: string = status,
    checks?: MergeCheckView["checks"],
  ) => {
    const q = confirmation();
    if (!("target" in q) || !("delivery_id" in q.target))
      throw new Error("Missing completion");
    const gated = {
      ...f.state,
      project_settings: { merge_gate_enabled: true },
    };
    const identity = {
      card_id: f.card.id,
      completion_id: q.target.delivery_id,
      attempt_id: `attempt-${attempt}`,
      candidate_sha: "b".repeat(40),
      tree_sha: (status === "passed" ? "c" : "d").repeat(40),
    };
    f.commit(
      recordMergeCheck(gated, system, { ...identity, status: "queued" }, f.io),
    );
    if (status === "queued") return;
    f.commit(
      recordMergeCheck(
        { ...f.state, project_settings: { merge_gate_enabled: true } },
        system,
        { ...identity, status: "running" },
        f.io,
      ),
    );
    if (status === "running") return;
    f.commit(
      recordMergeCheck(
        { ...f.state, project_settings: { merge_gate_enabled: true } },
        system,
        {
          ...identity,
          status,
          summary: status,
          log_ref: `${identity.attempt_id}.log`,
          checks: checks ?? [
            {
              name: "test",
              status,
              exit_code: status === "passed" ? 0 : 1,
              duration_ms: 1,
            },
          ],
        },
        f.io,
      ),
    );
  };
  const pmResolve = (
    option: string,
    extra: { notice?: string; escalate?: boolean } = {},
    state = f.state,
  ) =>
    resolveDelegatedDecision(
      state,
      opsActor,
      {
        decision_id: confirmation().id,
        option,
        rationale: `选择 ${option}`,
        ...extra,
      },
      f.io,
    );
  const raise = (
    category: DecisionCategory,
    extra: Partial<RequestDecisionParams> = {},
  ) =>
    f.commit(
      requestDecision(
        f.state,
        human,
        {
          card_id: f.card.id,
          category,
          kind: "choose",
          question: "需要额外处理？",
          context: "背景",
          options: [{ key: "yes", description: "处理", impact: "影响" }],
          recommended: "yes",
          affected_cards: [],
          affected_work_items: [],
          blocking: false,
          decider: "human",
          plain_summary: TEST_PLAIN_SUMMARY,
          ...extra,
        },
        f.io,
      ),
    );
  return { f, confirmation, check, pmResolve, raise };
}

test("merge confirmation defaults to PM Ops with recorded authority", async () => {
  const { f, confirmation } = setup();
  expect(projectPreferences(f.state).pm_merge_confirmation).toBeUndefined();
  await f.accept();
  expect(confirmation()).toMatchObject({
    decider: "role:pm",
    delegation_authority: `project:${human.project_id}/default-pm-merge-confirmation`,
  });
  // PM Ops sees it in its queue together with what still blocks merge.
  const queue = value(listNeedsYou(f.state, opsActor)).data.pm_queue;
  expect(queue?.decisions.map((q) => q.id)).toEqual([confirmation().id]);
  expect(queue?.merge_blockers?.[confirmation().id]).toEqual([
    expect.stringContaining("合并闸门检查尚无结果"),
  ]);
  // Not shown to the human as a blocking Needs You decision.
  expect(
    value(listNeedsYou(f.state, human)).data.decisions.map((q) => q.id),
  ).not.toContain(confirmation().id);
});

test("PM Ops can choose merge only after the gate passed, with a notice", async () => {
  const { f, confirmation, check, pmResolve } = setup();
  await f.accept();
  const before = pmResolve("merge", { notice: "合并 X" });
  expect(before.ok).toBe(false);
  if (!before.ok) expect(before.error.code).toBe("illegal_transition");
  check("failed");
  expect(pmResolve("merge", { notice: "合并 X" }).ok).toBe(false);
  check("passed");
  expect(pmMergeBlockers(f.state, confirmation())).toEqual([]);
  // The notice is mandatory when PM confirms a merge.
  expect(pmResolve("merge").ok).toBe(false);
  f.commit(pmResolve("merge", { notice: "常规修复，已合并。" }));
  expect(confirmation()).toMatchObject({
    status: "resolved",
    resolution: {
      option: "merge",
      via: "delegated",
      notice: "常规修复，已合并。",
      proxy_authority: `project:${human.project_id}/default-pm-merge-confirmation`,
    },
  });
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test("failed or missing verification and open must_fix block a PM merge", async () => {
  const { f, confirmation, check, pmResolve } = setup();
  const { product } = await f.accept();
  check("passed");
  const verify = f.state.work_items.find(
    (w) =>
      w.card_id === f.card.id &&
      w.kind === "verify" &&
      w.role_id === "reviewer",
  );
  if (!verify) throw new Error("Missing verifier");
  const unverified: CommandState = {
    ...f.state,
    work_items: f.state.work_items.map((w) =>
      w.id === verify.id ? ({ ...w, status: "failed" } as WorkItem) : w,
    ),
  };
  expect(pmMergeBlockers(unverified, confirmation())).toEqual([
    `验证项 ${verify.id} 未通过`,
  ]);
  expect(pmResolve("merge", { notice: "n" }, unverified).ok).toBe(false);
  const review = f.state.reviews.find((r) => r.delivery_id === product.id);
  if (!review) throw new Error("Missing review");
  const mustFix: CommandState = {
    ...f.state,
    reviews: [
      ...f.state.reviews,
      {
        ...review,
        id: id("review", 999),
        issues: [
          {
            severity: "major",
            description: "必须修",
            must_fix: true,
            pre_existing: false,
          },
        ],
        verdict: "reject",
        blocking: true,
      },
    ],
  };
  expect(pmMergeBlockers(mustFix, confirmation())).toEqual([
    `审核 ${id("review", 999)} 有未处理的 must_fix`,
  ]);
  expect(pmResolve("merge", { notice: "n" }, mustFix).ok).toBe(false);
  // A pre-existing must_fix does not block.
  const preExisting: CommandState = {
    ...mustFix,
    reviews: mustFix.reviews.map((r) =>
      r.id === id("review", 999)
        ? { ...r, issues: r.issues.map((i) => ({ ...i, pre_existing: true })) }
        : r,
    ),
  };
  expect(pmMergeBlockers(preExisting, confirmation())).toEqual([]);
});

test("without merge preconditions PM Ops can still hold or request changes", async () => {
  const hold = setup();
  await hold.f.accept();
  hold.f.commit(hold.pmResolve("hold"));
  expect(hold.confirmation()).toMatchObject({
    status: "snoozed",
    decider: "role:pm",
  });
  expect(notices(hold.f.state)).toEqual([]);
  const until = hold.confirmation().snooze?.until;
  if (!until) throw new Error("Missing expiry");
  hold.f.commit(
    expireMergeSnoozes(hold.f.state, system, {
      ...hold.f.io,
      clock: { now: () => until },
    }),
  );
  expect(hold.confirmation()).toMatchObject({
    decider: "role:pm",
    status: "open",
  });

  const back = setup();
  await back.f.accept();
  const effect = value(back.pmResolve("request_changes"));
  expect(effect.events.map((e) => e.type)).toContain("merge_changes_requested");
});

test.each([
  "spending",
  "account",
  "permission",
  "data_deletion",
  "scope_change",
] as const)(
  "a %s decision on the card keeps merge confirmation with the human",
  async (category) => {
    const { f, confirmation, raise, pmResolve, check } = setup();
    raise(category);
    await f.accept();
    check("passed");
    expect(confirmation().decider).toBe("human");
    expect(confirmation().context).toContain("合并须由人确认");
    expect(pmResolve("merge", { notice: "n" }).ok).toBe(false);
    // C-29's timeout cannot substitute for the required human answer.
    value(
      setProjectPreferences(
        f.state,
        human,
        { auto_merge_after_minutes: 1 },
        f.io,
      ),
    );
    expect(autoMergeSchedule(f.state, confirmation().id).ok).toBe(false);
  },
);

test("a sensitive decision raised later hands an open PM merge confirmation to the human", async () => {
  const { f, confirmation, raise } = setup();
  await f.accept();
  expect(confirmation().decider).toBe("role:pm");
  raise("permission");
  expect(confirmation()).toMatchObject({ decider: "human", status: "open" });
  expect(
    value(listNeedsYou(f.state, human)).data.decisions.map((q) => q.id),
  ).toContain(confirmation().id);
});

// C-167 (trial finding 68): a D12 question raised on a card waiting for merge
// only moves that card's merge confirmation when it is about the merge content.
test("a permission decision marked unrelated to the merge leaves the PM confirmation alone", async () => {
  const { f, confirmation, raise, check, pmResolve } = setup();
  await f.accept();
  const held = confirmation();
  expect(held.decider).toBe("role:pm");
  const before = f.state.events.length;
  const q = raise("permission", { merge_related: false }) as Decision;
  expect(q).toMatchObject({ decider: "human", merge_related: false });
  expect(q.context).toContain(`与 ${f.card.id} 的合并内容无关`);
  expect(confirmation()).toEqual(held);
  expect(
    f.state.events
      .slice(before)
      .filter(
        (e) =>
          e.type === "decision_requested" &&
          (e.payload as { decision_id?: string }).decision_id === held.id,
      ),
  ).toEqual([]);
  expect(mergeRequiresHuman(f.state, confirmation())).toBe(false);
  check("passed");
  f.commit(pmResolve("merge", { notice: "与权限拍板无关，按常规合并。" }));
  expect(confirmation().status).toBe("resolved");
});

// Reviews V-540 / V-543: an Agent cannot exempt a card from the human merge.
// It cannot set merge_related=false, and answering its question (even with a
// refusal) is not an authorization to skip the human merge confirmation.
const agentRaise = (
  f: ReturnType<typeof setup>["f"],
  extra: Partial<RequestDecisionParams> = {},
) =>
  requestDecision(
    f.state,
    f.actor(f.coder),
    {
      card_id: f.card.id,
      category: "permission",
      kind: "choose",
      question: "允许本卡实现取消管理员写接口的鉴权吗？",
      context: "本卡交付直接修改管理员接口的访问控制，需要人确认权限取舍。",
      options: [
        { key: "allow", description: "允许", impact: "取消鉴权" },
        { key: "deny", description: "拒绝取消鉴权", impact: "保留鉴权" },
      ],
      recommended: "deny",
      affected_cards: [],
      affected_work_items: [],
      blocking: false,
      decider: "human",
      plain_summary: TEST_PLAIN_SUMMARY,
      ...extra,
    },
    f.io,
  );
const humanAnswers = (
  f: ReturnType<typeof setup>["f"],
  q: Decision,
  option: string,
) =>
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option,
        rationale: "人的业务回答",
        raw_quote: option,
      },
      f.io,
    ),
  );

test.each(["allow", "deny"])(
  "an Agent cannot mark a D12 question merge-unrelated; after the human answers %s, PM still cannot confirm",
  async (option) => {
    const { f, confirmation, check, pmResolve } = setup();
    await f.accept();
    const held = confirmation();
    expect(held.decider).toBe("role:pm");
    const before = f.state;
    const labeled = agentRaise(f, { merge_related: false });
    expect(labeled.ok).toBe(false);
    if (!labeled.ok) expect(labeled.error.code).toBe("unauthorized");
    expect(f.state).toBe(before);
    // Without the label the question is merge-related: handed over, pinned.
    const q = f.commit(agentRaise(f)) as Decision;
    expect(q.merge_related).toBeUndefined();
    expect(confirmation()).toMatchObject({
      decider: "human",
      plain_summary: TEST_PLAIN_SUMMARY,
      human_required_reason: expect.stringContaining(q.id),
    });
    check("passed");
    humanAnswers(f, q, option);
    expect(mergeRequiresHuman(f.state, confirmation())).toBe(true);
    const pm = pmResolve("merge", { notice: "n" });
    expect(pm.ok).toBe(false);
    expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  },
);

test.each(["allow", "deny"])(
  "an Agent's D12 question is never auto-merged, even after the human answers %s",
  async (option) => {
    const { f, confirmation } = setup(false);
    f.commit(
      setProjectPreferences(
        f.state,
        human,
        { auto_merge_after_minutes: 1 },
        f.io,
      ),
    );
    await f.accept();
    expect(confirmation().decider).toBe("human");
    expect(agentRaise(f, { merge_related: false }).ok).toBe(false);
    const q = f.commit(agentRaise(f)) as Decision;
    expect(confirmation().human_required_reason).toContain(q.id);
    humanAnswers(f, q, option);
    const later = {
      ...f.io,
      clock: {
        now: () => new Date(Date.parse(now) + 2 * 60_000).toISOString(),
      },
    };
    expect(
      autoConfirmMerge(
        f.state,
        system,
        { decision_id: confirmation().id },
        later,
      ).ok,
    ).toBe(false);
    expect(confirmation().status).toBe("open");
  },
);

test("a stored merge_related=false label without a human raiser does not lift the human merge", async () => {
  const { f, confirmation } = setup();
  await f.accept();
  const q = f.commit(agentRaise(f)) as Decision;
  // Even if such a record existed (e.g. written before this rule), only a
  // human raiser makes the label count.
  const forged: CommandState = {
    ...f.state,
    decisions: f.state.decisions.map((d): Decision => {
      if (d.id === q.id) return { ...d, merge_related: false };
      if (d.id !== confirmation().id) return d;
      const { human_required_reason: _pinned, ...rest } = d;
      return rest;
    }),
  };
  const pinned = forged.decisions.find((d) => d.id === confirmation().id);
  if (!pinned) throw new Error("Missing confirmation");
  expect(mergeRequiresHuman(forged, pinned)).toBe(true);
});

test("a merge-related permission decision hands the confirmation over as human-required, never auto-merged", async () => {
  const { f, confirmation, raise } = setup();
  await f.accept();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { auto_merge_after_minutes: 1 },
      f.io,
    ),
  );
  expect(confirmation().decider).toBe("role:pm");
  const q = raise("permission") as Decision;
  expect(q.merge_related).toBeUndefined();
  expect(confirmation()).toMatchObject({
    decider: "human",
    plain_summary: TEST_PLAIN_SUMMARY,
    status: "open",
    human_required_reason: expect.stringContaining(q.id),
  });
  expect(confirmation().human_required_reason).toContain("不适用超时自动合并");
  expect(f.state.events.at(-1)).toMatchObject({
    type: "decision_requested",
    payload: {
      decision_id: confirmation().id,
      previous_decider: "role:pm",
    },
  });
  expect(autoMergeSchedule(f.state, confirmation().id).ok).toBe(false);
  const later = {
    ...f.io,
    clock: {
      now: () => new Date(Date.parse(now) + 24 * 60 * 60_000).toISOString(),
    },
  };
  expect(
    autoConfirmMerge(f.state, system, { decision_id: confirmation().id }, later)
      .ok,
  ).toBe(false);
  // The flag is persisted on the confirmation: it does not lapse when the
  // permission question itself is no longer counted.
  const withoutQuestion: CommandState = {
    ...f.state,
    decisions: f.state.decisions.map((d) =>
      d.id === q.id ? { ...d, status: "withdrawn" } : d,
    ),
  };
  expect(mergeRequiresHuman(withoutQuestion, confirmation())).toBe(true);
  expect(autoMergeSchedule(withoutQuestion, confirmation().id).ok).toBe(false);
});

test("a merge-related permission decision also pins a human-held confirmation", async () => {
  const { f, confirmation, raise } = setup();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { pm_merge_confirmation: false, auto_merge_after_minutes: 1 },
      f.io,
    ),
  );
  await f.accept();
  expect(confirmation()).toMatchObject({ decider: "human" });
  expect(confirmation().human_required_reason).toBeUndefined();
  raise("spending");
  expect(confirmation().human_required_reason).toContain("高风险事项");
  const later = {
    ...f.io,
    clock: {
      now: () => new Date(Date.parse(now) + 24 * 60 * 60_000).toISOString(),
    },
  };
  expect(
    autoConfirmMerge(f.state, system, { decision_id: confirmation().id }, later)
      .ok,
  ).toBe(false);
});

test("a project-level permission decision does not move a card's merge confirmation", async () => {
  const { f, confirmation } = setup();
  await f.accept();
  const held = confirmation();
  f.commit(
    requestDecision(
      f.state,
      human,
      {
        category: "permission",
        kind: "choose",
        question: "全局开放权限？",
        context: "项目级",
        options: [{ key: "yes", description: "开放", impact: "影响" }],
        recommended: "yes",
        affected_cards: [],
        affected_work_items: [],
        blocking: false,
        decider: "human",
        plain_summary: TEST_PLAIN_SUMMARY,
      },
      f.io,
    ),
  );
  expect(confirmation()).toEqual(held);
});

test("only a D12 question that touches no produce work and binds no target can be marked unrelated", async () => {
  const { f, raise } = setup();
  await f.accept();
  const produce = f.state.work_items.find(
    (w) => w.card_id === f.card.id && w.kind === "produce",
  );
  if (!produce) throw new Error("Missing produce work item");
  const verify = f.state.work_items.find(
    (w) => w.card_id === f.card.id && w.kind === "verify",
  );
  if (!verify) throw new Error("Missing verify work item");
  for (const extra of [
    { category: "general" as const },
    { category: "scope_change" as const },
    { affected_work_items: [produce.id] },
    {
      kind: "approve" as const,
      target: { subject: { kind: "git_head" as const, value: "a".repeat(40) } },
    },
  ]) {
    const result = requestDecision(
      f.state,
      human,
      {
        card_id: f.card.id,
        category: "permission",
        kind: "choose",
        question: "需要额外处理？",
        context: "背景",
        options: [{ key: "yes", description: "处理", impact: "影响" }],
        recommended: "yes",
        affected_cards: [],
        affected_work_items: [],
        blocking: false,
        decider: "human",
        plain_summary: TEST_PLAIN_SUMMARY,
        merge_related: false,
        ...extra,
      },
      f.io,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation_failed");
  }
  // A reviewer's own verify item is not merge content.
  const q = raise("permission", {
    merge_related: false,
    affected_work_items: [verify.id],
  }) as Decision;
  expect(q.merge_related).toBe(false);
});

test("PM Ops may hand a merge to the human with a reason; no auto-merge then", async () => {
  const { f, confirmation, pmResolve } = setup();
  await f.accept();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { auto_merge_after_minutes: 1 },
      f.io,
    ),
  );
  f.commit(pmResolve("merge", { escalate: true }));
  expect(confirmation()).toMatchObject({
    decider: "human",
    plain_summary: TEST_PLAIN_SUMMARY,
    human_required_reason: "项目经理升级给你：选择 merge",
  });
  expect(confirmation().context).toContain("项目经理升级给你");
  expect(autoMergeSchedule(f.state, confirmation().id).ok).toBe(false);
  // The human answers through the local CLI as well as the Workbench.
  const cli = recordDecision(
    f.state,
    human,
    {
      decision_id: confirmation().id,
      option: "hold",
      rationale: "再看看",
      raw_quote: "再看看",
    },
    f.io,
  );
  expect(cli.ok).toBe(true);
});

test("turning PM merge confirmation off returns to human confirmation with auto-merge fallback", async () => {
  const { f, confirmation } = setup();
  await f.accept();
  const open = confirmation();
  expect(open.decider).toBe("role:pm");
  expect(
    setProjectPreferences(
      f.state,
      opsActor,
      { pm_merge_confirmation: false },
      f.io,
    ).ok,
  ).toBe(false);
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { pm_merge_confirmation: false, auto_merge_after_minutes: 1 },
      f.io,
    ),
  );
  expect(f.state.events).toContainEqual(
    expect.objectContaining({
      type: "project_preferences_updated",
      payload: {
        old_value: true,
        new_value: false,
        preference: "pm_merge_confirmation",
      },
    }),
  );
  expect(confirmation()).toMatchObject({ id: open.id, decider: "human" });
  expect(confirmation().human_required_reason).toBeUndefined();
  // C-29 timeout stays as the fallback in human mode.
  const later = {
    ...f.io,
    clock: { now: () => new Date(Date.parse(now) + 60_000).toISOString() },
  };
  f.commit(autoConfirmMerge(f.state, system, { decision_id: open.id }, later));
  expect(confirmation().resolution).toMatchObject({
    option: "merge",
    resolved_by: "system",
  });
  expect(notices(f.state)[0]).toMatchObject({
    kind: "merge",
    resolved_by: "system",
    decision_id: open.id,
  });
});

test("new confirmations go to the human while the setting is off or no PM Ops is active", async () => {
  const off = setup();
  off.f.commit(
    setProjectPreferences(
      off.f.state,
      human,
      { pm_merge_confirmation: false },
      off.f.io,
    ),
  );
  await off.f.accept();
  expect(off.confirmation().decider).toBe("human");
  expect(off.confirmation().delegation_authority).toBeUndefined();
  const noOps = setup(false);
  await noOps.f.accept();
  expect(noOps.confirmation().decider).toBe("human");
});

test("delegated resolutions become non-blocking notices the human can mark read", async () => {
  const { f, check, pmResolve, confirmation } = setup();
  const general = f.commit(
    requestDecision(
      f.state,
      human,
      {
        card_id: f.card.id,
        category: "general",
        kind: "choose",
        question: "流程问题？",
        context: "背景",
        options: [{ key: "a", description: "方案 A", impact: "影响" }],
        recommended: "a",
        affected_cards: [],
        affected_work_items: [],
        blocking: false,
        decider: "human",
        plain_summary: TEST_PLAIN_SUMMARY,
      },
      f.io,
    ),
  ) as Decision;
  expect(general.decider).toBe("role:pm");
  f.commit(
    resolveDelegatedDecision(
      f.state,
      opsActor,
      { decision_id: general.id, option: "a", rationale: "按惯例" },
      f.io,
    ),
  );
  await f.accept();
  check("passed");
  f.commit(pmResolve("merge", { notice: "改了登录页；无风险。" }));
  const list = notices(f.state);
  expect(list).toMatchObject([
    {
      kind: "merge",
      decision_id: confirmation().id,
      body: "改了登录页；无风险。",
      read: false,
    },
    {
      kind: "decision",
      decision_id: general.id,
      body: "方案 A。理由：按惯例",
      proxy_authority: expect.stringContaining("general"),
      read: false,
    },
  ]);
  const ids = list.map((n) => n.id);
  expect(markNoticesRead(f.state, opsActor, { notice_ids: ids }, f.io).ok).toBe(
    false,
  );
  expect(
    markNoticesRead(f.state, human, { notice_ids: ["missing"] }, f.io).ok,
  ).toBe(false);
  f.commit(
    markNoticesRead(f.state, human, { notice_ids: [ids[0] as string] }, f.io),
  );
  expect(notices(f.state).map((n) => n.read)).toEqual([true, false]);
  const again = value(
    markNoticesRead(f.state, human, { notice_ids: [ids[0] as string] }, f.io),
  );
  expect(again.events).toEqual([]);
  // Reading never touches decisions.
  expect(again.changes).toEqual([]);
});

const officeRecord = (state: CommandState, decision_id: Decision["id"]) =>
  recordDecision(
    state,
    officeActor,
    {
      decision_id,
      option: "merge",
      rationale: "前台代记",
      raw_quote: "合并",
    },
    ports(),
  );

test.each([
  "spending",
  "account",
  "permission",
  "data_deletion",
  "scope_change",
] as const)(
  "PM Office cannot transcribe the human-only merge of a %s card",
  async (category) => {
    const { f, confirmation, raise, check } = setup();
    raise(category);
    await f.accept();
    check("passed");
    expect(confirmation().decider).toBe("human");
    const office = officeRecord(f.state, confirmation().id);
    expect(office.ok).toBe(false);
    if (!office.ok) expect(office.error.code).toBe("forbidden_tool");
    // The human still answers through Workbench or the local CLI.
    f.commit(
      recordDecision(
        f.state,
        human,
        {
          decision_id: confirmation().id,
          option: "merge",
          rationale: "确认",
          raw_quote: "合并",
        },
        f.io,
      ),
    );
    expect(mergePlan(f.state, f.card.id).ok).toBe(true);
  },
);

test("PM Office cannot transcribe a merge PM Ops handed to the human", async () => {
  const { f, confirmation, pmResolve } = setup();
  await f.accept();
  f.commit(pmResolve("merge", { escalate: true }));
  expect(officeRecord(f.state, confirmation().id).ok).toBe(false);
});

test("a card created from a sensitive decision keeps its merge with the human", async () => {
  const { f, confirmation, check, pmResolve } = setup();
  const source = f.commit(
    requestDecision(
      f.state,
      human,
      {
        category: "permission",
        kind: "choose",
        question: "开放管理员权限？",
        context: "项目级",
        options: [{ key: "yes", description: "开放", impact: "建卡实施" }],
        recommended: "yes",
        affected_cards: [],
        affected_work_items: [],
        blocking: false,
        decider: "human",
        plain_summary: TEST_PLAIN_SUMMARY,
      },
      f.io,
    ),
  ) as Decision;
  await f.accept();
  check("passed");
  const derived: CommandState = {
    ...f.state,
    cards: f.state.cards.map((c) =>
      c.id === f.card.id
        ? { ...c, source: { kind: "decision", decision_id: source.id } }
        : c,
    ),
  };
  // A confirmation already with PM Ops is no longer authorized for it.
  const pm = pmResolve("merge", { notice: "n" }, derived);
  expect(pm.ok).toBe(false);
  // A newly requested confirmation goes straight to the human.
  const held = value(pmResolve("hold"));
  const afterHold = {
    ...derived,
    decisions: derived.decisions.map(
      (q) =>
        held.changes.find(
          (c) => c.collection === "decisions" && c.entity.id === q.id,
        )?.entity ?? q,
    ) as Decision[],
    events: [...derived.events, ...held.events],
  };
  const again = value(
    requestMerge(legacyHolds(afterHold), human, { card_id: f.card.id }, f.io),
  ).data;
  expect(again.decider).toBe("human");
  expect(again.context).toContain("来源拍板");
  expect(confirmation().id).not.toBe(again.id);
});

test("a non-required verifier that has not passed still blocks a PM merge", async () => {
  const { f, confirmation, check } = setup();
  await f.accept();
  check("passed");
  const template = f.state.work_items.find(
    (w) => w.card_id === f.card.id && w.kind === "verify",
  );
  if (!template) throw new Error("Missing verifier");
  const optional = {
    ...template,
    id: id("work_item", 998),
    template_key: undefined,
    required: false,
    status: "todo",
  } as unknown as WorkItem;
  const state: CommandState = {
    ...f.state,
    work_items: [...f.state.work_items, optional],
  };
  expect(pmMergeBlockers(state, confirmation())).toEqual([
    `验证项 ${optional.id} 未通过`,
  ]);
});

test("notices are ordered by resolution time across cards, not by per-card seq", () => {
  const base = setup().f.state;
  const resolved = (n: number, card: string, seq: number, at: string) => ({
    id: String(n).padStart(26, "0"),
    card_id: card,
    seq,
    type: "decision_resolved",
    actor: opsActor,
    payload: {
      decision_id: `q(${n})`,
      option: "a",
      option_description: `决定 ${n}`,
      rationale: "r",
      via: "delegated",
    },
    created_at: at,
  });
  const events = [
    ...Array.from({ length: 50 }, (_, i) =>
      resolved(i + 1, "C-101", 100 + i, "2026-01-01T00:00:00.000Z"),
    ),
    resolved(99, "C-156", 3, "2026-01-02T00:00:00.000Z"),
  ] as unknown as CommandState["events"];
  const list = notices({ ...base, events });
  expect(list[0]?.decision_id).toBe("q(99)");
  expect(list.slice(0, 50).map((n) => n.decision_id)).toContain("q(99)");
});

// C-65: human-only sensitive flag and human takeover of PM-held merges.
const sensitive = (
  state: CommandState,
  actor: Actor,
  card_id: CardId,
  on: boolean,
) => setCardSensitive(state, actor, { card_id, sensitive: on }, ports());

test("only the human can mark or unmark a card sensitive, and both are on the timeline", async () => {
  const { f } = setup();
  const coder = f.actor(f.coder);
  for (const actor of [opsActor, officeActor, coder, system]) {
    const rejected = sensitive(f.state, actor, f.card.id, true);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok)
      expect(["forbidden_tool", "unauthorized"]).toContain(rejected.error.code);
  }
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: true },
      f.io,
    ),
  );
  expect(f.state.cards.find((c) => c.id === f.card.id)?.sensitive).toBe(true);
  // Agents cannot unmark either.
  for (const actor of [opsActor, officeActor, coder])
    expect(sensitive(f.state, actor, f.card.id, false).ok).toBe(false);
  // Repeating the same value records nothing.
  const same = value(sensitive(f.state, human, f.card.id, true));
  expect(same.events).toEqual([]);
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: false },
      f.io,
    ),
  );
  expect(
    f.state.cards.find((c) => c.id === f.card.id)?.sensitive,
  ).toBeUndefined();
  const changes = f.state.events.filter(
    (e) => e.type === "card_sensitivity_changed",
  );
  expect(changes.map((e) => [e.actor.kind, e.payload])).toEqual([
    ["human", { card_id: f.card.id, sensitive: true }],
    ["human", { card_id: f.card.id, sensitive: false }],
  ]);
  const entries = f.state.timeline.filter((t) =>
    changes.some((e) => e.seq === t.event_seq && e.card_id === t.card_id),
  );
  expect(entries).toHaveLength(2);
  for (const entry of entries) {
    expect(entry.author).toBe("human");
    expect(entry.created_at).toEqual(expect.any(String));
  }
  expect(entries[0]?.body).toContain("标为敏感");
  expect(entries[1]?.body).toContain("取消");
});

test("a sensitive card's merge confirmation is the human's: no PM Ops, no PM Office, no auto-merge", async () => {
  const { f, confirmation, check, pmResolve } = setup();
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { auto_merge_after_minutes: 1 },
      f.io,
    ),
  );
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: true },
      f.io,
    ),
  );
  await f.accept();
  check("passed");
  expect(confirmation()).toMatchObject({ decider: "human", status: "open" });
  expect(confirmation().delegation_authority).toBeUndefined();
  expect(confirmation().context).toContain("标为敏感");
  const pm = pmResolve("merge", { notice: "n" });
  expect(pm.ok).toBe(false);
  if (!pm.ok) expect(pm.error.code).toBe("unauthorized");
  expect(officeRecord(f.state, confirmation().id).ok).toBe(false);
  expect(autoMergeSchedule(f.state, confirmation().id).ok).toBe(false);
  const later = {
    ...f.io,
    clock: { now: () => new Date(Date.parse(now) + 3_600_000).toISOString() },
  };
  expect(
    autoConfirmMerge(f.state, system, { decision_id: confirmation().id }, later)
      .ok,
  ).toBe(false);
  // Turning PM merge confirmation on/off or the category cannot route it to PM.
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { pm_merge_confirmation: true },
      f.io,
    ),
  );
  expect(confirmation().decider).toBe("human");
  expect(confirmation().category).toBe("general");
  // The human confirms it personally.
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: confirmation().id,
        option: "merge",
        rationale: "我确认",
        raw_quote: "合并",
      },
      f.io,
    ),
  );
  expect(confirmation().resolution).toMatchObject({
    resolved_by: "human",
    via: "needs_you",
  });
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test("marking a card sensitive hands its PM-held confirmation to the human at once", async () => {
  const { f, confirmation, check, pmResolve } = setup();
  await f.accept();
  check("passed");
  const held = confirmation();
  expect(held.decider).toBe("role:pm");
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: true },
      f.io,
    ),
  );
  expect(confirmation()).toMatchObject({
    id: held.id,
    decider: "human",
    plain_summary: TEST_PLAIN_SUMMARY,
    status: "open",
  });
  expect(f.state.events.at(-1)).toMatchObject({
    type: "decision_requested",
    payload: expect.objectContaining({
      decision_id: held.id,
      previous_decider: "role:pm",
    }),
  });
  expect(pmResolve("merge", { notice: "n" }).ok).toBe(false);
  expect(pmResolve("hold").ok).toBe(false);
  const needs = value(listNeedsYou(f.state, human)).data;
  expect(needs.decisions.map((q) => q.id)).toContain(held.id);
  expect(needs.pm_held_merges.map((q) => q.id)).not.toContain(held.id);
  expect(
    value(listNeedsYou(f.state, opsActor)).data.pm_queue?.decisions,
  ).toEqual([]);
});

test("after the flag is removed, a new confirmation after a legacy hold goes back to PM Ops", async () => {
  const { f, confirmation, pmResolve } = setup();
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: true },
      f.io,
    ),
  );
  await f.accept();
  expect(confirmation().decider).toBe("human");
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: false },
      f.io,
    ),
  );
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: confirmation().id,
        option: "hold",
        rationale: "稍后",
        raw_quote: "稍后",
      },
      f.io,
    ),
  );
  f.commit(
    requestMerge(legacyHolds(f.state), human, { card_id: f.card.id }, f.io),
  );
  expect(confirmation()).toMatchObject({ decider: "role:pm", status: "open" });
  expect(pmResolve("hold").ok).toBe(true);
});

test.each(["merge", "hold", "request_changes"] as const)(
  "the human can answer a PM-held merge confirmation directly (%s); PM Ops then cannot",
  async (option) => {
    const { f, confirmation, check, pmResolve } = setup();
    await f.accept();
    check("passed");
    const held = confirmation();
    expect(held.decider).toBe("role:pm");
    // Shown to the human as directly answerable, not as waiting on them.
    const needs = value(listNeedsYou(f.state, human)).data;
    expect(needs.pm_held_merges.map((q) => q.id)).toEqual([held.id]);
    expect(needs.decisions.map((q) => q.id)).not.toContain(held.id);
    expect(needs.pm_held_merges[0]?.merge_confirmation?.completion?.id).toBe(
      "target" in held && "delivery_id" in held.target
        ? held.target.delivery_id
        : undefined,
    );
    // PM Office still cannot transcribe it.
    expect(officeRecord(f.state, held.id).ok).toBe(false);
    const effect = value(
      recordDecision(
        f.state,
        human,
        {
          decision_id: held.id,
          option,
          rationale: "我直接处理",
          raw_quote: "我直接处理",
        },
        f.io,
      ),
    );
    f.commit({ ok: true, value: effect });
    expect(confirmation()).toMatchObject({
      id: held.id,
      decider: "human",
      plain_summary: TEST_PLAIN_SUMMARY,
      ...(option === "hold"
        ? { status: "snoozed", snooze: { reason: "我直接处理", by: "human" } }
        : {
            status: "resolved",
            resolution: {
              option,
              resolved_by: "human",
              via: "needs_you",
              taken_over_from: "role:pm",
            },
          }),
    });
    expect(confirmation().resolution?.proxy_authority).toBeUndefined();
    expect(
      effect.events.find(
        (e) =>
          e.type ===
          (option === "hold"
            ? "merge_confirmation_snoozed"
            : "decision_resolved"),
      )?.payload,
    ).toMatchObject({ taken_over_from: "role:pm" });
    const again = pmResolve(option === "merge" ? "hold" : "merge", {
      notice: "n",
    });
    expect(again.ok).toBe(false);
    expect(pmResolve(option).ok).toBe(false);
    // It is the human's answer, not a delegated notice.
    expect(notices(f.state).map((n) => n.decision_id)).not.toContain(held.id);
    expect(value(listNeedsYou(f.state, human)).data.pm_held_merges).toEqual([]);
  },
);

test("a human merge of a PM-held confirmation still has to pass the merge gate", async () => {
  const { f, confirmation, check } = setup();
  await f.accept();
  check("failed");
  const held = confirmation();
  expect(held.decider).toBe("role:pm");
  // PM Ops could not merge now; the human may confirm, but the gate decides.
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: held.id,
        option: "merge",
        rationale: "我来确认",
        raw_quote: "合并",
      },
      f.io,
    ),
  );
  const gated = () => ({
    ...f.state,
    project_settings: { merge_gate_enabled: true },
  });
  const completion_id =
    "target" in held && "delivery_id" in held.target
      ? held.target.delivery_id
      : undefined;
  if (!completion_id) throw new Error("Missing completion");
  const merged = (tree: string) => ({
    card_id: f.card.id,
    completion_id,
    result: {
      kind: "merged" as const,
      merge_sha: "b".repeat(40),
      previous_sha: "a".repeat(40),
      tree_sha: tree.repeat(40),
    },
  });
  // The failed tree cannot be published.
  expect(recordMergeResult(gated(), system, merged("d"), f.io)).toMatchObject({
    ok: false,
    error: { code: "invariant_violation" },
  });
  check("passed");
  f.commit(recordMergeResult(gated(), system, merged("c"), f.io));
  expect(f.state.cards.find((c) => c.id === f.card.id)?.status).toBe("done");
});

// C-65 review V-189: the flag must hold for auto-policy cards and for a merge
// PM Ops already confirmed but the host has not published yet.
const humanMerge = (
  f: ReturnType<typeof setup>["f"],
  decision_id: Decision["id"],
) =>
  f.commit(
    recordDecision(
      f.state,
      human,
      { decision_id, option: "merge", rationale: "我确认", raw_quote: "合并" },
      f.io,
    ),
  );

test("a sensitive auto-policy card still needs the human to confirm its merge", async () => {
  const { f, confirmation, pmResolve } = setup(true, "auto");
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: true },
      f.io,
    ),
  );
  await f.accept();
  expect(confirmation()).toMatchObject({ decider: "human", status: "open" });
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  expect(pmResolve("merge", { notice: "n" }).ok).toBe(false);
  humanMerge(f, confirmation().id);
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test("an unmarked auto-policy card keeps merging without confirmation", async () => {
  const { f } = setup(true, "auto");
  await f.accept();
  expect(
    f.state.decisions.filter((q) => q.trigger === "merge_confirmation"),
  ).toEqual([]);
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test("marking an auto-policy card awaiting merge asks the human; unmarking restores auto merge", async () => {
  const { f, confirmation } = setup(true, "auto");
  await f.accept();
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: true },
      f.io,
    ),
  );
  const asked = confirmation();
  expect(asked).toMatchObject({ decider: "human", status: "open" });
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: false },
      f.io,
    ),
  );
  expect(confirmation()).toMatchObject({ id: asked.id, status: "superseded" });
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test("marking after PM Ops confirmed but before publication supersedes PM's answer and asks the human", async () => {
  const { f, confirmation, check, pmResolve } = setup();
  await f.accept();
  check("passed");
  f.commit(pmResolve("merge", { notice: "常规合并" }));
  const delegated = confirmation();
  expect(delegated.resolution?.via).toBe("delegated");
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: true },
      f.io,
    ),
  );
  // PM's answer stays on record but no longer authorizes publication.
  const old = f.state.decisions.find((q) => q.id === delegated.id);
  expect(old).toMatchObject({
    status: "superseded",
    resolution: { via: "delegated", option: "merge" },
  });
  const asked = confirmation();
  expect(asked).toMatchObject({
    decider: "human",
    plain_summary: TEST_PLAIN_SUMMARY,
    status: "open",
    amends: delegated.id,
  });
  expect(mergePlan(f.state, f.card.id).ok).toBe(false);
  const completion_id =
    "target" in asked && "delivery_id" in asked.target
      ? asked.target.delivery_id
      : undefined;
  if (!completion_id) throw new Error("Missing completion");
  const merged = {
    card_id: f.card.id,
    completion_id,
    result: {
      kind: "merged" as const,
      merge_sha: "b".repeat(40),
      previous_sha: "a".repeat(40),
      tree_sha: "c".repeat(40),
    },
  };
  const gated = () => ({
    ...f.state,
    project_settings: { merge_gate_enabled: true },
  });
  expect(recordMergeResult(gated(), system, merged, f.io).ok).toBe(false);
  expect(pmResolve("merge", { notice: "n" }).ok).toBe(false);
  humanMerge(f, asked.id);
  f.commit(recordMergeResult(gated(), system, merged, f.io));
  expect(f.state.cards.find((c) => c.id === f.card.id)?.status).toBe("done");
});

test("publication re-checks the flag against a non-human merge answer", async () => {
  const { f, confirmation, check, pmResolve } = setup();
  await f.accept();
  check("passed");
  f.commit(pmResolve("merge", { notice: "常规合并" }));
  // Even if the flag landed without the sync (e.g. an older writer), the
  // publication check refuses PM's answer for a sensitive card.
  const raw: CommandState = {
    ...f.state,
    cards: f.state.cards.map((c) =>
      c.id === f.card.id ? { ...c, sensitive: true } : c,
    ),
  };
  expect(confirmation().resolution?.via).toBe("delegated");
  const plan = mergePlan(raw, f.card.id);
  expect(plan.ok).toBe(false);
  if (!plan.ok) expect(plan.error.message).toContain("由人亲自确认");
});

test("a merge the human already confirmed stands when the card is marked", async () => {
  const { f, confirmation, check } = setup();
  await f.accept();
  check("passed");
  const held = confirmation();
  humanMerge(f, held.id);
  f.commit(
    setCardSensitive(
      f.state,
      human,
      { card_id: f.card.id, sensitive: true },
      f.io,
    ),
  );
  expect(confirmation()).toMatchObject({ id: held.id, status: "resolved" });
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

// P2a-1 §2.6 / 试行发现 43: PM Ops handles failed or timed-out merge checks.
const failedQueue = (state: CommandState) =>
  value(listNeedsYou(state, opsActor)).data.pm_queue?.failed_merge_checks ?? [];
const humanPending = (state: CommandState) =>
  value(listNeedsYou(state, human)).data.decisions.map((q) => q.id);

test.each([
  undefined,
  "queued",
  "running",
  "failed",
  "timed_out",
  "interrupted",
  "passed",
] as const)(
  "C-115: human merge confirmation waits for the current check (%s)",
  async (status) => {
    const { f, confirmation, check } = setup();
    f.commit(sensitive(f.state, human, f.card.id, true));
    await f.accept();
    if (status) check(status);
    const state = {
      ...f.state,
      project_settings: { merge_gate_enabled: true },
    };
    const needs = value(listNeedsYou(state, human)).data;
    // C-171: ended checks (failed, timed out, interrupted) never pass by
    // themselves, so the human sees them listed; queued/running are summarized.
    const visible = !!status && !["queued", "running"].includes(status);
    expect(needs.decisions.some((q) => q.id === confirmation().id)).toBe(
      visible,
    );
    expect(needs.waiting_merge_checks_count).toBe(visible ? 0 : 1);
    expect(needs.waiting_merge_check_items).toEqual(
      visible
        ? []
        : [
            {
              decision_id: confirmation().id,
              card_id: f.card.id,
              check_status: status ?? null,
            },
          ],
    );
    // PM Ops' queue keeps every human confirmation whose check has not passed.
    expect(
      value(
        listNeedsYou(state, opsActor),
      ).data.pm_queue?.waiting_merge_checks.map((q) => q.id),
    ).toEqual(status === "passed" ? [] : [confirmation().id]);
    // Disabled projects and direct human commands retain their behavior.
    expect(humanPending(f.state)).toContain(confirmation().id);
    expect(
      recordDecision(
        state,
        human,
        {
          decision_id: confirmation().id,
          option: "merge",
          rationale: "合并",
          raw_quote: "合并",
        },
        f.io,
      ).ok,
    ).toBe(true);
  },
);

test("C-115: a previous pass cannot expose a new tree or completion", async () => {
  const { f, confirmation, check } = setup();
  f.commit(sensitive(f.state, human, f.card.id, true));
  await f.accept();
  check("passed");
  check("queued", "new-tree");
  const state = { ...f.state, project_settings: { merge_gate_enabled: true } };
  expect(humanPending(state)).not.toContain(confirmation().id);
  const oldEvents = state.events.filter(
    (e) =>
      e.type !== "merge_check_queued" ||
      (e.payload as { attempt_id?: string }).attempt_id !== "attempt-new-tree",
  );
  const completion = state.deliveries.find((d) => d.kind === "card_completion");
  if (!completion) throw new Error("Missing completion");
  const newer = { ...completion, id: id("delivery", 999) };
  expect(
    humanPending({
      ...state,
      events: oldEvents,
      deliveries: [...state.deliveries, newer],
      decisions: state.decisions.map((q) =>
        q.id === confirmation().id
          ? { ...q, target: { delivery_id: newer.id } }
          : q,
      ),
    }),
  ).not.toContain(confirmation().id);
});

test.each([
  "sensitive",
  "spending",
  "account",
  "permission",
  "data_deletion",
  "scope_change",
  "escalated",
] as const)(
  "C-115: %s only permits PM Ops to recheck structured timeouts",
  async (kind) => {
    for (const confirmed of [false, true]) {
      const { f, confirmation, check, pmResolve, raise } = setup();
      if (kind === "sensitive")
        f.commit(sensitive(f.state, human, f.card.id, true));
      else if (kind !== "escalated") raise(kind);
      await f.accept();
      if (kind === "escalated") f.commit(pmResolve("hold", { escalate: true }));
      if (confirmed)
        f.commit(
          recordDecision(
            f.state,
            human,
            {
              decision_id: confirmation().id,
              option: "merge",
              rationale: "合并",
              raw_quote: "合并",
            },
            f.io,
          ),
        );
      check("timed_out");
      const original = confirmation();
      expect(failedQueue(f.state)).toEqual([
        expect.objectContaining({
          decision_id: original.id,
          options: ["recheck"],
        }),
      ]);
      for (const option of ["merge", "hold", "request_changes"])
        expect(pmResolve(option, { notice: "n" }).ok).toBe(false);
      expect(pmResolve("recheck").ok).toBe(false);
      expect(pmResolve("recheck", { notice: "n", escalate: true }).ok).toBe(
        false,
      );
      for (const actor of [
        officeActor,
        { kind: "system", project_id: human.project_id } as Actor,
      ])
        expect(
          resolveDelegatedDecision(
            f.state,
            actor,
            {
              decision_id: original.id,
              option: "recheck",
              rationale: "超时",
              notice: "重新检查",
            },
            f.io,
          ).ok,
        ).toBe(false);
      const off = {
        ...f.state,
        project_preferences: [
          {
            id: f.state.project_id,
            auto_merge_after_minutes: null,
            pm_merge_confirmation: false,
          },
        ],
      };
      expect(pmResolve("recheck", { notice: "n" }, off).ok).toBe(false);
      const disabled = {
        ...f.state,
        assignments: f.state.assignments.map((a) =>
          a.id === ops.id ? { ...a, status: "suspended" as const } : a,
        ),
      };
      expect(pmResolve("recheck", { notice: "n" }, disabled).ok).toBe(false);
      f.commit(pmResolve("recheck", { notice: "检查步骤超时，已重新检查。" }));
      expect(confirmation()).toEqual(original);
      expect(notices(f.state)).toContainEqual(
        expect.objectContaining({
          option: "recheck",
          body: "检查步骤超时，已重新检查。",
        }),
      );
      expect(pmResolve("recheck", { notice: "n" }).ok).toBe(false);
      expect(failedQueue(f.state)).toEqual([]);
    }
  },
);

test.each([
  { status: "timed_out" as const, checks: [], allowed: true },
  {
    status: "failed" as const,
    checks: [
      { name: "test", status: "timed_out" as const },
      { name: "lint", status: "not_run" as const },
    ],
    allowed: true,
  },
  {
    status: "timed_out" as const,
    checks: [{ name: "test", status: "failed" as const }],
    allowed: false,
  },
  {
    status: "failed" as const,
    checks: [{ name: "timeout in log", status: "failed" as const }],
    allowed: false,
  },
  {
    status: "timed_out" as const,
    checks: [{ name: "test", status: "interrupted" as const }],
    allowed: false,
  },
])(
  "C-115: timeout eligibility is structured and rejects mixed failures ($allowed)",
  async ({ status, checks, allowed }) => {
    const { f, check, pmResolve } = setup();
    f.commit(sensitive(f.state, human, f.card.id, true));
    await f.accept();
    check(status, "classification", checks);
    expect(pmResolve("recheck", { notice: "重新检查" }).ok).toBe(allowed);
  },
);

test("PM Ops returns a PM-held confirmation whose check failed, with reason and notice", async () => {
  const { f, confirmation, check, pmResolve } = setup();
  const { product } = await f.accept();
  // No check yet: recheck is refused and nothing is offered.
  expect(pmResolve("recheck", { notice: "n" }).ok).toBe(false);
  check("failed");
  const q = confirmation();
  expect(failedQueue(f.state)).toEqual([
    expect.objectContaining({
      decision_id: q.id,
      card_id: f.card.id,
      confirmation_status: "open",
      options: ["request_changes", "recheck"],
      check: expect.objectContaining({ status: "failed" }),
    }),
  ]);
  // Reason and notice are both mandatory.
  const blank = resolveDelegatedDecision(
    f.state,
    opsActor,
    {
      decision_id: q.id,
      option: "request_changes",
      rationale: " ",
      notice: "n",
    },
    f.io,
  );
  expect(blank.ok).toBe(false);
  expect(pmResolve("request_changes").ok).toBe(false);
  const effect = value(
    pmResolve("request_changes", {
      notice: `${f.card.id} 合并检查失败（test 用例与本卡改动相关），已退回修改。`,
    }),
  );
  f.commit({ ok: true, value: effect });
  // Same effects as the human return: completion superseded, producer reworks.
  expect(effect.events.map((e) => e.type)).toContain("merge_changes_requested");
  expect(f.state.cards.find((c) => c.id === f.card.id)?.status).toBe(
    "in_progress",
  );
  expect(
    f.state.work_items.find((w) => w.id === product.work_item_id)?.status,
  ).toBe("changes_requested");
  expect(confirmation().resolution).toMatchObject({
    option: "request_changes",
    via: "delegated",
  });
  expect(notices(f.state)[0]).toMatchObject({
    kind: "merge",
    option: "request_changes",
    resolved_by: "pm",
    card_id: f.card.id,
    body: expect.stringContaining("已退回修改"),
  });
  expect(failedQueue(f.state)).toEqual([]);
});

test("PM Ops rechecks a timed-out confirmed merge once, then returns it after another failure", async () => {
  const { f, confirmation, check, pmResolve } = setup();
  // Human mode with the C-29 timeout: the confirmation is auto-approved.
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { pm_merge_confirmation: false, auto_merge_after_minutes: 1 },
      f.io,
    ),
  );
  const { product } = await f.accept();
  const q = confirmation();
  expect(q.decider).toBe("human");
  const later = {
    ...f.io,
    clock: { now: () => new Date(Date.parse(now) + 60_000).toISOString() },
  };
  f.commit(autoConfirmMerge(f.state, system, { decision_id: q.id }, later));
  // C-79: processing failures also needs the current PM authorization.
  f.commit(
    setProjectPreferences(
      f.state,
      human,
      { pm_merge_confirmation: true },
      f.io,
    ),
  );
  const authorization = confirmation().resolution;
  expect(authorization).toMatchObject({ option: "merge" });
  check("timed_out");
  // PM Ops picks it up instead of leaving it for the human.
  expect(failedQueue(f.state)).toEqual([
    expect.objectContaining({
      decision_id: q.id,
      confirmation_status: "resolved",
    }),
  ]);
  expect(humanPending(f.state)).not.toContain(q.id);
  // C-171: with the gate on, PM Ops' failure is neither listed nor summarized.
  const gated = value(
    listNeedsYou(
      { ...f.state, project_settings: { merge_gate_enabled: true } },
      human,
    ),
  ).data;
  expect(gated.decisions.map((d) => d.id)).not.toContain(q.id);
  expect(gated.waiting_merge_checks_count).toBe(0);
  // A confirmed merge cannot be merged or held again by PM.
  expect(pmResolve("hold", { notice: "n" }).ok).toBe(false);
  expect(pmResolve("recheck").ok).toBe(false);
  const recheck = value(
    pmResolve("recheck", {
      notice: `${f.card.id} 合并检查超时（负载导致），已重新检查。`,
    }),
  );
  f.commit({ ok: true, value: recheck });
  expect(recheck.events).toContainEqual(
    expect.objectContaining({
      type: "merge_check_requeued",
      payload: expect.objectContaining({
        status: "queued",
        recheck_requested: true,
        via: "delegated",
        decision_id: q.id,
      }),
    }),
  );
  expect(notices(f.state).find((n) => n.option === "recheck")).toMatchObject({
    option: "recheck",
    resolved_by: "pm",
    body: expect.stringContaining("已重新检查"),
  });
  // While the recheck is queued nothing may be returned or rechecked again.
  expect(pmResolve("request_changes", { notice: "n" }).ok).toBe(false);
  expect(pmResolve("recheck", { notice: "n" }).ok).toBe(false);
  expect(failedQueue(f.state)).toEqual([]);
  check("failed", "retry");
  const back = value(
    pmResolve("request_changes", {
      notice: `${f.card.id} 重新检查仍失败，已退回修改。`,
    }),
  );
  f.commit({ ok: true, value: back });
  // Same effects as the human return of a confirmed merge.
  expect(confirmation()).toMatchObject({
    status: "superseded",
    resolution: authorization,
  });
  expect(
    f.state.work_items.find((w) => w.id === product.work_item_id)?.status,
  ).toBe("changes_requested");
  expect(back.events).toContainEqual(
    expect.objectContaining({
      type: "merge_changes_requested",
      payload: expect.objectContaining({
        decision_id: q.id,
        run_kind: "fix",
        reason: "选择 request_changes",
        via: "delegated",
      }),
    }),
  );
  expect(
    notices(f.state).find((n) => n.option === "request_changes"),
  ).toMatchObject({
    option: "request_changes",
    body: expect.stringContaining("仍失败"),
  });
  expect(pmResolve("request_changes", { notice: "n" }).ok).toBe(false);
  // Only one side takes effect: the human can no longer return it either.
  expect(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option: "request_changes",
        rationale: "退回",
        raw_quote: "退回",
      },
      f.io,
    ).ok,
  ).toBe(false);
});

test.each(
  (["human", "pm", "timeout"] as const).flatMap((source) =>
    (["failed", "timed_out"] as const).map((status) => ({ source, status })),
  ),
)(
  "current preference controls a $source-confirmed $status merge",
  async ({ source, status }) => {
    const { f, confirmation, check, pmResolve } = setup();
    if (source !== "pm")
      f.commit(
        setProjectPreferences(
          f.state,
          human,
          {
            pm_merge_confirmation: false,
            auto_merge_after_minutes: 1,
          },
          f.io,
        ),
      );
    await f.accept();
    const q = confirmation();
    if (source === "pm") {
      check("passed");
      f.commit(pmResolve("merge", { notice: "检查通过，确认合并。" }));
    } else if (source === "timeout") {
      f.commit(
        autoConfirmMerge(
          f.state,
          system,
          { decision_id: q.id },
          {
            ...f.io,
            clock: {
              now: () => new Date(Date.parse(now) + 60_000).toISOString(),
            },
          },
        ),
      );
    } else {
      f.commit(
        recordDecision(
          f.state,
          human,
          {
            decision_id: q.id,
            option: "merge",
            rationale: "合并",
            raw_quote: "合并",
          },
          f.io,
        ),
      );
    }
    const original = confirmation();
    check(status);
    // Turning off hands back every source without rewriting its original authorization.
    f.commit(
      setProjectPreferences(
        f.state,
        human,
        { pm_merge_confirmation: false },
        f.io,
      ),
    );
    expect(confirmation()).toEqual(original);
    expect(failedQueue(f.state)).toEqual([]);
    const pending = value(listNeedsYou(f.state, human)).data.decisions;
    expect(pending).toEqual([
      expect.objectContaining({
        id: q.id,
        status: "resolved",
        why: "合并检查失败或超时，可退回修改或重新检查",
        options: [expect.objectContaining({ key: "request_changes" })],
      }),
    ]);
    for (const option of ["request_changes", "recheck"]) {
      const denied = pmResolve(option, { notice: "处理失败检查。" });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("unauthorized");
    }
    // Both human entry points remain valid against the same failed snapshot.
    const returned = value(
      recordDecision(
        f.state,
        human,
        {
          decision_id: q.id,
          option: "request_changes",
          rationale: "修复失败",
          raw_quote: "修复失败",
        },
        f.io,
      ),
    );
    expect(
      returned.events.some((e) => e.type === "merge_changes_requested"),
    ).toBe(true);
    expect(returned.data).toMatchObject({
      status: "superseded",
      decider: original.decider,
      resolution: original.resolution,
    });
    const rechecked = value(
      recheckMerge(
        {
          ...f.state,
          project_settings: { merge_gate_enabled: true },
        },
        human,
        { card_id: f.card.id },
        f.io,
      ),
    );
    expect(
      rechecked.events.some((e) => e.type === "merge_check_requeued"),
    ).toBe(true);
    // Re-enabling immediately restores PM's queue and both authorized actions.
    f.commit(
      setProjectPreferences(
        f.state,
        human,
        { pm_merge_confirmation: true },
        f.io,
      ),
    );
    expect(confirmation()).toEqual(original);
    expect(humanPending(f.state)).not.toContain(q.id);
    expect(failedQueue(f.state)).toEqual([
      expect.objectContaining({ decision_id: q.id }),
    ]);
    expect(pmResolve("request_changes", { notice: "退回修改。" }).ok).toBe(
      true,
    );
    expect(pmResolve("recheck", { notice: "重新检查。" }).ok).toBe(true);
  },
);

test("PM Ops cannot return a confirmed merge whose check passed", async () => {
  const { f, confirmation, check, pmResolve } = setup();
  await f.accept();
  check("passed");
  f.commit(pmResolve("merge", { notice: "已合并" }));
  expect(confirmation().status).toBe("resolved");
  expect(pmResolve("request_changes", { notice: "n" }).ok).toBe(false);
  expect(pmResolve("recheck", { notice: "n" }).ok).toBe(false);
  expect(failedQueue(f.state)).toEqual([]);
});

test.each([
  "spending",
  "account",
  "permission",
  "data_deletion",
  "scope_change",
] as const)(
  "a failed check on a %s card stays with the human",
  async (category) => {
    const { f, confirmation, raise, check, pmResolve } = setup();
    raise(category);
    await f.accept();
    const q = confirmation();
    f.commit(
      recordDecision(
        f.state,
        human,
        {
          decision_id: q.id,
          option: "merge",
          rationale: "合并",
          raw_quote: "合并",
        },
        { ...f.io, human_confirmation: "workbench" },
      ),
    );
    check("failed");
    expect(failedQueue(f.state)).toEqual([]);
    for (const option of ["request_changes", "recheck"]) {
      const result = pmResolve(option, { notice: "n" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("unauthorized");
    }
    expect(humanPending(f.state)).toContain(q.id);
  },
);

test("PM Ops may hand a failed confirmed merge to the human instead", async () => {
  const { f, confirmation, check, pmResolve } = setup();
  await f.accept();
  const q = confirmation();
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option: "merge",
        rationale: "合并",
        raw_quote: "合并",
      },
      f.io,
    ),
  );
  check("failed");
  expect(humanPending(f.state)).not.toContain(q.id);
  f.commit(pmResolve("request_changes", { escalate: true }));
  expect(confirmation()).toMatchObject({
    status: "resolved",
    decider: "human",
    plain_summary: TEST_PLAIN_SUMMARY,
    human_required_reason: expect.stringContaining("项目经理升级给你"),
  });
  expect(failedQueue(f.state)).toEqual([]);
  expect(humanPending(f.state)).toContain(q.id);
  expect(pmResolve("request_changes", { notice: "n" }).ok).toBe(false);
  // Without an active PM Ops the human keeps the item, as before.
  const noOps = setup(false);
  await noOps.f.accept();
  const nq = noOps.confirmation();
  noOps.f.commit(
    recordDecision(
      noOps.f.state,
      human,
      {
        decision_id: nq.id,
        option: "merge",
        rationale: "合并",
        raw_quote: "合并",
      },
      noOps.f.io,
    ),
  );
  noOps.check("failed");
  expect(humanPending(noOps.f.state)).toContain(nq.id);
});

test("a failed check on a card the human flagged sensitive stays with the human (C-65)", async () => {
  const { f, confirmation, check, pmResolve } = setup();
  f.commit(sensitive(f.state, human, f.card.id, true));
  await f.accept();
  const q = confirmation();
  expect(q.decider).toBe("human");
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option: "merge",
        rationale: "合并",
        raw_quote: "合并",
      },
      f.io,
    ),
  );
  check("failed");
  expect(failedQueue(f.state)).toEqual([]);
  for (const option of ["request_changes", "recheck"]) {
    const result = pmResolve(option, { notice: "n" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unauthorized");
  }
  expect(humanPending(f.state)).toContain(q.id);
});

/** Old databases retain resolved holds; requestMerge must still support them. */
function legacyHolds(state: CommandState): CommandState {
  return {
    ...state,
    decisions: state.decisions.map(
      (q): Decision =>
        q.status === "snoozed"
          ? {
              ...q,
              status: "resolved",
              resolution: {
                option: "hold",
                rationale: "Legacy hold",
                raw_quote: "Legacy hold",
                resolved_by: "human",
                via: "needs_you",
                via_chain: ["human"],
                at: now,
              },
            }
          : q,
    ),
  };
}
