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
  needsYouItemReady,
  type Result,
  requestDecision,
  requestHumanAction,
  standingTools,
  triageHumanAction,
} from "../index.js";
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
    ask(f, { blocks_merge: true, ready_when: { kind: "manual" } }),
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
        ready_when: { kind: "card_merged", card_id: id("card", 1) },
      }),
    ),
  ).toBe("validation_failed");
  expect(
    codes(
      ask(f, {
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
