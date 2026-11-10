import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  autoConfirmMerge,
  autoMergeSchedule,
  type CommandState,
  type Decision,
  type DecisionCategory,
  listNeedsYou,
  markNoticesRead,
  mergePlan,
  notices,
  pmMergeBlockers,
  projectPreferences,
  recordDecision,
  recordMergeCheck,
  requestDecision,
  requestMerge,
  resolveDelegatedDecision,
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

function setup(withOps = true) {
  const empty: CommandState = {
    project_id: human.project_id,
    roles: [role("coder"), role("reviewer"), role("pm")],
    cards: [],
    work_items: [],
    assignments: withOps ? [ops] : [],
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
  const f = mergeFixture("confirm", 3, { state: empty, ports: ports() });
  const confirmation = () => {
    const q = f.state.decisions
      .filter((q) => q.trigger === "merge_confirmation")
      .at(-1);
    if (!q) throw new Error("Missing merge confirmation");
    return q;
  };
  const check = (status: "passed" | "failed") => {
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
      attempt_id: `attempt-${status}`,
      candidate_sha: "b".repeat(40),
      tree_sha: (status === "passed" ? "c" : "d").repeat(40),
    };
    f.commit(
      recordMergeCheck(gated, system, { ...identity, status: "queued" }, f.io),
    );
    f.commit(
      recordMergeCheck(
        { ...f.state, project_settings: { merge_gate_enabled: true } },
        system,
        { ...identity, status: "running" },
        f.io,
      ),
    );
    f.commit(
      recordMergeCheck(
        { ...f.state, project_settings: { merge_gate_enabled: true } },
        system,
        {
          ...identity,
          status,
          summary: status,
          log_ref: `${identity.attempt_id}.log`,
          checks: [
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
  const raise = (category: DecisionCategory) =>
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
  expect(hold.confirmation().resolution?.option).toBe("hold");
  expect(notices(hold.f.state)[0]).toMatchObject({
    kind: "merge",
    option: "hold",
    resolved_by: "pm",
  });
  // Re-requesting after a hold goes back to PM Ops.
  hold.f.commit(
    requestMerge(hold.f.state, human, { card_id: hold.f.card.id }, hold.f.io),
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
