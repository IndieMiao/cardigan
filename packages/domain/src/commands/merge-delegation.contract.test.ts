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
  listNeedsYou,
  markNoticesRead,
  mergePlan,
  notices,
  pmMergeBlockers,
  projectPreferences,
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
    requestMerge(afterHold, human, { card_id: f.card.id }, f.io),
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

test("after the flag is removed, a new confirmation goes back to PM Ops", async () => {
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
  f.commit(requestMerge(f.state, human, { card_id: f.card.id }, f.io));
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
      status: "resolved",
      resolution: {
        option,
        resolved_by: "human",
        via: "needs_you",
        taken_over_from: "role:pm",
      },
    });
    expect(confirmation().resolution?.proxy_authority).toBeUndefined();
    expect(
      effect.events.find((e) => e.type === "decision_resolved")?.payload,
    ).toMatchObject({ via: "needs_you", taken_over_from: "role:pm" });
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
