// C-212: readiness conditions defer when a Needs You item is shown. They never
// change whether the item holds work or a merge, and a merge-holding item
// surfaces as soon as its card asks to complete.
import { expect, test } from "vitest";
import {
  type Actor,
  type Assignment,
  type CommandEffect,
  type Delivery,
  listNeedsYou,
  NEEDS_YOU_ITEM_READY,
  needsYouItemReady,
  pauseStandingAssignment,
  type Result,
  readinessTriggeredBy,
  readyNotices,
  requestDecision,
  requestHumanAction,
  standingTools,
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
  ports,
  role,
  subject,
  value,
} from "./test-fixtures.js";

const PLAIN = { changed: "改动", impact: "影响", risk: "无" };

function setup(withOps = true) {
  let state = fixture();
  const io = ports();
  const { work_item_id: _work, ...base } = assignment(4, "pm");
  const ops: Assignment = {
    ...base,
    scope: "standing",
    standing_mode: "ops",
    status: withOps ? "active" : "suspended",
  };
  const office: Assignment = {
    ...base,
    id: id("assignment", 5),
    scope: "standing",
    standing_mode: "office",
    external: true,
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
  return {
    get state() {
      return state;
    },
    set state(next) {
      state = next;
    },
    io,
    ops,
    pm: identity(ops),
    front: identity(office),
    commit<T>(result: Result<CommandEffect<T>>) {
      const effect = value(result);
      state = apply(state, effect);
      return effect.data;
    },
  };
}
type Fixture = ReturnType<typeof setup>;

const ask = (
  f: Fixture,
  extra: Partial<Parameters<typeof requestHumanAction>[2]> = {},
) =>
  requestHumanAction(
    f.state,
    actor(),
    {
      card_id: id("card", 1),
      instructions: "在主机上执行首次部署",
      why_human: "需要主机权限",
      expected_return: "部署结果",
      blocked_work_items: [],
      ...extra,
    },
    f.io,
  );
const needs = (f: Fixture) => value(listNeedsYou(f.state, human)).data;
const delivery = (n: number, kind: Delivery["kind"] = "code"): Delivery => ({
  id: id("delivery", n),
  work_item_id: id("work_item", 1),
  run_id: id("run", 1),
  kind,
  summary: "交付",
  subject,
  evidence: [],
  attachments: [],
  known_gaps: [],
  requested_verifiers: [],
  status: "submitted",
});
const setCard = (f: Fixture, n: number, status: "done" | "cancelled") => {
  f.state = {
    ...f.state,
    cards: f.state.cards.map((c) =>
      c.id === id("card", n) ? { ...c, status } : c,
    ),
  };
};

test("a deferred action is listed under later until its card merges, and keeps blocking work", () => {
  const f = setup(false);
  const action = f.commit(
    ask(f, {
      blocks_merge: true,
      prerequisite: "external_account" as const,
      blocked_work_items: [id("work_item", 1)],
      ready_when: { kind: "card_merged", card_id: id("card", 2) },
    }),
  );
  expect(action.ready_when).toEqual({
    kind: "card_merged",
    card_id: id("card", 2),
  });
  expect(needs(f).human_actions).toEqual([]);
  expect(needs(f).later).toEqual([
    expect.objectContaining({
      kind: "human_action",
      id: action.id,
      waiting_for: "等 C-2 合并",
    }),
  ]);
  // Deferral never releases what the action holds.
  expect(
    f.state.work_items.find((w) => w.id === id("work_item", 1))?.status,
  ).toBe("blocked");
  setCard(f, 2, "done");
  expect(needs(f).human_actions.map((h) => h.id)).toEqual([action.id]);
  expect(needs(f).later).toEqual([]);
});

test("a cancelled target card makes the item ready instead of hiding it forever", () => {
  const f = setup(false);
  const action = f.commit(
    ask(f, { ready_when: { kind: "card_delivery", card_id: id("card", 2) } }),
  );
  expect(needs(f).later.map((l) => l.id)).toEqual([action.id]);
  setCard(f, 2, "cancelled");
  expect(needs(f).human_actions.map((h) => h.id)).toEqual([action.id]);
});

test("card_delivery waits for a delivery newer than the one present at request time", () => {
  const f = setup(false);
  f.state = { ...f.state, deliveries: [delivery(1)] };
  const action = f.commit(
    ask(f, { ready_when: { kind: "card_delivery", card_id: id("card", 1) } }),
  );
  expect(action.ready_when).toEqual({
    kind: "card_delivery",
    card_id: id("card", 1),
    after: id("delivery", 1),
  });
  expect(needs(f).later.map((l) => l.id)).toEqual([action.id]);
  f.state = { ...f.state, deliveries: [delivery(1), delivery(2)] };
  expect(needs(f).human_actions.map((h) => h.id)).toEqual([action.id]);
});

test("a merge-holding deferred action surfaces at its card's completion request", () => {
  const f = setup();
  const holding = f.commit(
    ask(f, {
      blocks_merge: true,
      prerequisite: "external_account" as const,
      ready_when: { kind: "manual" },
    }),
  );
  const loose = f.commit(ask(f, { ready_when: { kind: "manual" } }));
  const rewrite = (h: typeof holding) =>
    f.commit(
      triageHumanAction(
        f.state,
        f.pm,
        {
          human_action_id: h.id,
          disposition: "human",
          rationale: "需要人在主机上执行",
          title: "首次部署",
          summary: "上线",
          why_human: "主机权限",
          expected_outcome: "上线完成",
          instructions: "1. 执行部署",
          expected_return: "结果",
        },
        f.io,
      ),
    );
  rewrite(holding);
  rewrite(loose);
  expect(
    needs(f)
      .later.map((l) => l.id)
      .sort(),
  ).toEqual([holding.id, loose.id].sort());
  f.state = { ...f.state, deliveries: [delivery(1, "card_completion")] };
  expect(needs(f).human_actions.map((h) => h.id)).toEqual([holding.id]);
  expect(needs(f).later.map((l) => l.id)).toEqual([loose.id]);
});

test("conditions that would deadlock, are already met, or cannot be released are rejected", () => {
  const f = setup(false);
  const codes = (r: Result<unknown>) => (r.ok ? "ok" : r.error.code);
  expect(
    codes(
      ask(f, {
        blocks_merge: true,
        prerequisite: "external_account" as const,
        ready_when: { kind: "card_merged", card_id: id("card", 1) },
      }),
    ),
  ).toBe("validation_failed");
  expect(
    codes(
      ask(f, {
        blocks_merge: true,
        prerequisite: "external_account" as const,
        blocked_work_items: [id("work_item", 1)],
        ready_when: { kind: "card_merged", card_id: id("card", 1) },
      }),
    ),
  ).toBe("validation_failed");
  // Nothing held: waiting for its own card's merge is fine.
  expect(
    codes(
      ask(f, { ready_when: { kind: "card_merged", card_id: id("card", 1) } }),
    ),
  ).toBe("ok");
  // No PM Ops can release a manual condition.
  expect(codes(ask(f, { ready_when: { kind: "manual" } }))).toBe(
    "validation_failed",
  );
  setCard(f, 2, "done");
  expect(
    codes(
      ask(f, { ready_when: { kind: "card_merged", card_id: id("card", 2) } }),
    ),
  ).toBe("validation_failed");
  expect(
    codes(
      ask(f, {
        ready_when: { kind: "card_delivery", card_id: id("card", 9) },
      }),
    ),
  ).toBe("validation_failed");
});

test("PM Ops triages to an external host operator with a one-line todo and releases it later", () => {
  const f = setup();
  const action = f.commit(ask(f));
  const triage = (
    extra: Partial<Parameters<typeof triageHumanAction>[2]> = {},
    keepCondition = false,
  ) => {
    const { ready_when, ...rest } = {
      ready_when: { kind: "manual" } as const,
      ...extra,
    };
    return triageHumanAction(
      f.state,
      f.pm,
      {
        human_action_id: action.id,
        disposition: "host",
        rationale: "外接操作员在主机上执行",
        title: "首次部署（暂不执行）",
        todo: "在主机上执行首次部署",
        summary: "自动部署第一次上线",
        why_human: "需要主机权限",
        expected_outcome: "服务上线",
        instructions: "1. 拉取基线\n2. 执行部署",
        expected_return: "部署结果",
        host_operator: "external",
        host_assignment_id: id("assignment", 5),
        ...rest,
        ...(keepCondition ? {} : { ready_when }),
      },
      f.io,
    );
  };
  expect(
    triage({ disposition: "human" }).ok,
    "host_operator only goes with host",
  ).toBe(false);
  expect(triage({ todo: "第一行\n第二行" }).ok).toBe(false);
  const next = f.commit(triage());
  expect(next).toMatchObject({
    triage: "host",
    host_operator: "external",
    ready_when: { kind: "manual" },
    handoff: { todo: "在主机上执行首次部署" },
  });
  expect(needs(f).human_actions).toEqual([]);
  expect(needs(f).later).toEqual([
    expect.objectContaining({ id: action.id, triage: "host" }),
  ]);
  const release = (who: Actor) =>
    triageHumanAction(
      f.state,
      who,
      {
        human_action_id: action.id,
        disposition: "release",
        rationale: "前置卡已合并",
      },
      f.io,
    );
  expect(release(f.front).ok).toBe(false);
  const released = f.commit(release(f.pm));
  expect(released.ready_released?.reason).toBe("前置卡已合并");
  expect(needsYouItemReady(f.state, released)).toBe(true);
  expect(needs(f).human_actions).toEqual([
    expect.objectContaining({ id: action.id, host_operator: "external" }),
  ]);
  const again = release(f.pm);
  expect(again.ok ? "ok" : again.error.code).toBe("illegal_transition");
  // Rewriting keeps the release unless a new condition is set.
  const rewritten = f.commit(triage({}, true));
  expect(rewritten.ready_released).toBeDefined();
  expect(f.commit(triage()).ready_released).toBeUndefined();
});

test("host triage defaults to the host_ops tier", () => {
  const f = setup();
  const action = f.commit(ask(f));
  const next = f.commit(
    triageHumanAction(
      f.state,
      f.pm,
      {
        human_action_id: action.id,
        disposition: "host",
        rationale: "主机同步",
        title: "同步基线",
        summary: "同步",
        why_human: "主机权限",
        expected_outcome: "完成",
        instructions: "1. 同步",
        expected_return: "SHA",
      },
      f.io,
    ),
  );
  expect(next.host_operator).toBe("host_ops");
});

test("only human decisions take a ready condition, and they wait under later", () => {
  const f = setup(false);
  const params = {
    card_id: id("card", 1),
    category: "general" as const,
    kind: "choose" as const,
    question: "上线后是否保留旧入口？",
    context: "上线后再定",
    options: [{ key: "keep", description: "保留", impact: "两个入口并存" }],
    recommended: "keep",
    affected_cards: [id("card", 1)],
    affected_work_items: [],
    blocking: false,
    plain_summary: PLAIN,
    ready_when: { kind: "card_merged" as const, card_id: id("card", 2) },
  };
  const q = f.commit(
    requestDecision(f.state, actor(), { ...params, decider: "human" }, f.io),
  );
  expect(needs(f).decisions).toEqual([]);
  expect(needs(f).later).toEqual([
    expect.objectContaining({ kind: "decision", id: q.id }),
  ]);
  setCard(f, 2, "done");
  expect(needs(f).decisions.map((d) => d.id)).toEqual([q.id]);
  const toPm = requestDecision(
    f.state,
    actor(),
    {
      ...params,
      decider: "role:pm",
      ready_when: { kind: "card_delivery", card_id: id("card", 1) },
    },
    f.io,
  );
  expect(toPm.ok ? "ok" : toPm.error.message).toBe(
    "只有交给人的拍板可以带就绪条件",
  );
});

test("V-823: items that pause work cannot wait for a delivery that work would make", () => {
  const f = setup(false);
  const codes = (r: Result<unknown>) => (r.ok ? "ok" : r.error.code);
  const decide = (blocking: boolean, card = 1) =>
    requestDecision(
      f.state,
      actor(),
      {
        card_id: id("card", 1),
        category: "permission",
        kind: "choose",
        question: "是否开放权限？",
        context: "等交付后再定",
        options: [{ key: "yes", description: "开放", impact: "可访问" }],
        recommended: "yes",
        affected_cards: [id("card", 1)],
        affected_work_items: [id("work_item", 1)],
        blocking,
        decider: "human",
        plain_summary: PLAIN,
        ready_when: { kind: "card_delivery", card_id: id("card", card) },
      },
      f.io,
    );
  // The reviewer's case: the blocking decision pauses W-1, the only producer.
  expect(codes(decide(true))).toBe("validation_failed");
  expect(
    f.state.work_items.find((w) => w.id === id("work_item", 1))?.status,
  ).toBe("in_progress");
  // Waiting on another card's delivery, or not pausing anything, is fine.
  expect(codes(decide(true, 2))).toBe("ok");
  const g = setup(false);
  expect(
    codes(
      requestDecision(
        g.state,
        actor(),
        {
          card_id: id("card", 1),
          category: "general",
          kind: "choose",
          question: "交付后保留旧入口吗？",
          context: "看交付再定",
          options: [{ key: "keep", description: "保留", impact: "并存" }],
          recommended: "keep",
          affected_cards: [id("card", 1)],
          affected_work_items: [],
          blocking: false,
          decider: "human",
          plain_summary: PLAIN,
          ready_when: { kind: "card_delivery", card_id: id("card", 1) },
        },
        g.io,
      ),
    ),
  ).toBe("ok");
  // A human action that pauses W-1 cannot wait for C-1's next delivery.
  expect(
    codes(
      ask(g, {
        blocks_merge: true,
        prerequisite: "external_account" as const,
        blocked_work_items: [id("work_item", 1)],
        ready_when: { kind: "card_delivery", card_id: id("card", 1) },
      }),
    ),
  ).toBe("validation_failed");
});

test("V-823: losing the last PM Ops releases every manual hold and hands it over", () => {
  const f = setup();
  const waiting = f.commit(
    ask(f, {
      blocks_merge: true,
      prerequisite: "external_account" as const,
      blocked_work_items: [id("work_item", 1)],
      ready_when: { kind: "manual" },
    }),
  );
  const triaged = f.commit(ask(f, { ready_when: { kind: "manual" } }));
  f.commit(
    triageHumanAction(
      f.state,
      f.pm,
      {
        human_action_id: triaged.id,
        disposition: "host",
        host_operator: "external",
        host_assignment_id: id("assignment", 5),
        rationale: "外接操作员执行",
        title: "首次部署",
        summary: "上线",
        why_human: "主机权限",
        expected_outcome: "上线完成",
        instructions: "1. 执行部署",
        expected_return: "结果",
      },
      f.io,
    ),
  );
  expect(needs(f).later.map((l) => l.id)).toEqual([triaged.id]);
  f.commit(
    pauseStandingAssignment(f.state, human, { assignment_id: f.ops.id }, f.io),
  );
  const actions = f.state.human_actions;
  expect(actions.find((h) => h.id === waiting.id)).toMatchObject({
    triage: "human",
    ready_released: { reason: expect.stringContaining("已无活跃后台") },
  });
  expect(actions.find((h) => h.id === triaged.id)).toMatchObject({
    triage: "host",
    ready_released: { reason: expect.stringContaining("已无活跃后台") },
  });
  expect(needs(f).later).toEqual([]);
  expect(
    needs(f)
      .human_actions.map((h) => h.id)
      .sort(),
  ).toEqual([waiting.id, triaged.id].sort());
  // Each handover is announced on the action's card for routing.
  expect(
    f.state.events
      .filter(
        (e) =>
          e.type === "human_action_requested" &&
          (e.payload as { human_action_id?: string }).human_action_id ===
            triaged.id &&
          (e.payload as { released?: boolean }).released === true,
      )
      .map((e) => e.card_id),
  ).toEqual([id("card", 1)]);
});

test("V-823: a non-Git card finished by completion review makes its waiters ready on the review event", async () => {
  const first = mergeFixture();
  const second = mergeFixture("confirm", 3, {
    state: first.state,
    ports: first.io,
  });
  // H waits on the second card's merge, raised on the first card.
  const h = second.commit(
    requestHumanAction(
      second.state,
      human,
      {
        card_id: first.card.id,
        instructions: "合并后核对文档",
        why_human: "需要人看",
        expected_return: "结论",
        blocked_work_items: [],
        ready_when: { kind: "card_merged", card_id: second.card.id },
      },
      second.io,
    ),
  );
  const waiting = () => value(listNeedsYou(second.state, human)).data;
  expect(waiting().later.map((l) => l.id)).toEqual([h.id]);
  await second.accept(false);
  expect(second.state.cards.find((c) => c.id === second.card.id)?.status).toBe(
    "done",
  );
  const last = second.state.events.at(-1);
  expect(last?.type).toMatch(/review_submitted|completion_reviewed/u);
  if (!last) throw new Error("no event");
  expect(
    readinessTriggeredBy(second.state, last).human_actions.map((a) => a.id),
  ).toEqual([h.id]);
  const notices = readyNotices(second.state, last);
  expect(notices).toEqual([
    {
      card_id: first.card.id,
      payload: expect.objectContaining({
        human_action_id: h.id,
        source_card_id: second.card.id,
        source_event_id: last.id,
        waiting_for: `等 ${second.card.id} 合并`,
      }),
      body: expect.stringContaining(h.id),
    },
  ]);
  expect(waiting().human_actions.map((a) => a.id)).toEqual([h.id]);
  // Announced once per condition: a recorded entry suppresses repeats.
  const recorded = {
    ...second.state,
    events: [
      ...second.state.events,
      {
        ...last,
        type: NEEDS_YOU_ITEM_READY,
        card_id: first.card.id,
        payload: notices[0]?.payload as never,
      },
    ],
  };
  expect(readyNotices(recorded, last)).toEqual([]);
});
