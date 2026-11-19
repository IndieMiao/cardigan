import { expect, test } from "vitest";
import {
  type Assignment,
  autoAssignProducer,
  type CommandState,
  type DecisionCategory,
  type Employee,
  listNeedsYou,
  type MachinePlacement,
  maintainPmCoordination,
  notices,
  OFFICE_WAIT_MS,
  pmRecoveryEligible,
  postComment,
  recordDecision,
  recoverStandingPm,
  requestDecision,
  requestHumanAction,
  resolveDelegatedDecision,
  triageHumanAction,
} from "../index.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  id,
  machine,
  now,
  placement,
  ports,
  run,
  value,
} from "./test-fixtures.js";

const system = { kind: "system" as const, project_id: human.project_id };
const plain = {
  changed: "处理本次开发问题",
  impact: "按选择继续工作",
  risk: "可能产生费用",
};
function setup() {
  let state = fixture();
  const { work_item_id: _work, ...base } = assignment(4, "pm");
  const ops: Assignment = { ...base, scope: "standing", standing_mode: "ops" };
  const office: Assignment = {
    ...ops,
    id: id("assignment", 5),
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
  const io = ports();
  let time = Date.parse(now);
  const clock = { now: () => new Date(time).toISOString() };
  const p = { ...io, clock };
  const tick = () => {
    const effect = value(maintainPmCoordination(state, system, p));
    state = apply(state, effect);
    return effect;
  };
  const request = (
    category: DecisionCategory = "spending",
    caller = actor(),
  ) => {
    const effect = value(
      requestDecision(
        state,
        caller,
        {
          card_id: id("card", 1),
          kind: "choose",
          category,
          question: `处理 ${category} 问题`,
          context: "本次问题的证据",
          options: [
            { key: "yes", description: "执行", impact: "使用资源" },
            { key: "no", description: "暂停", impact: "保留现状" },
          ],
          recommended: "no",
          affected_cards: [],
          affected_work_items: [],
          blocking: false,
          decider: "human",
          plain_summary: plain,
        },
        p,
      ),
    );
    state = apply(state, effect);
    return effect.data;
  };
  return {
    get state() {
      return state;
    },
    set state(s: CommandState) {
      state = s;
    },
    p,
    ops,
    office,
    tick,
    request,
    advance(ms: number) {
      time += ms;
    },
    comment(
      body: string,
      caller = actor(4, "pm"),
      reply_to?: Parameters<typeof postComment>[2]["reply_to"],
      mentions?: string[],
    ) {
      const effect = value(
        postComment(
          state,
          caller,
          {
            card_id: id("card", 1),
            body,
            ...(reply_to ? { reply_to } : {}),
            ...(mentions ? { mentions } : {}),
          },
          p,
        ),
      );
      state = apply(state, effect);
      if (!effect.data) throw new Error("Missing comment");
      return effect.data;
    },
  };
}

test.each([
  "spending",
  "credential",
  "publish",
  "account",
  "data_deletion",
] as const)(
  "author %s goes to PM inbox without granting authority, including absent Ops",
  (category) => {
    const f = setup();
    const q = f.request(category);
    expect(q).toMatchObject({ decider: "role:pm", pm_triage: true });
    expect(q.delegation_authority).toBeUndefined();
    expect(
      value(listNeedsYou(f.state, human, f.p.clock)).data.decisions,
    ).toHaveLength(0);
    expect(
      value(
        listNeedsYou(f.state, actor(4, "pm"), f.p.clock),
      ).data.pm_queue?.decisions.map((v) => v.id),
    ).toContain(q.id);
    expect(
      resolveDelegatedDecision(
        f.state,
        actor(4, "pm"),
        { decision_id: q.id, option: "yes", rationale: "直接处理" },
        f.p,
      ).ok,
    ).toBe(false);
    f.state = {
      ...f.state,
      assignments: f.state.assignments.map((a) =>
        a.id === f.ops.id ? { ...a, status: "suspended" } : a,
      ),
    };
    const waiting = f.request(category, actor(2, "reviewer"));
    expect(waiting.decider).toBe("role:pm");
    expect(
      value(listNeedsYou(f.state, human, f.p.clock)).data.decisions,
    ).toHaveLength(0);
  },
);

test("PM escalates same-card/category questions into one task without merging their answers or targets", () => {
  const f = setup();
  const first = f.request();
  const second = f.request("spending", actor(2, "reviewer"));
  const other = f.request("credential");
  f.state = {
    ...f.state,
    decisions: f.state.decisions.map((q) =>
      q.id === second.id
        ? { ...q, blocking: true, attachment_ids: ["attachment-1"] }
        : q,
    ),
  };
  const effect = value(
    resolveDelegatedDecision(
      f.state,
      actor(4, "pm"),
      {
        decision_id: first.id,
        option: "no",
        rationale: "这类事项尚未授权",
        escalate: true,
        plain_summary: plain,
      },
      f.p,
    ),
  );
  f.state = apply(f.state, effect);
  const items = value(listNeedsYou(f.state, human, f.p.clock)).data.decisions;
  expect(items).toHaveLength(1);
  expect(items[0]?.question).toContain("共 2 项");
  expect(items[0]?.context).toContain(second.id);
  expect(items[0]?.context).toContain("当前按钮只回答");
  expect(items[0]).toMatchObject({
    blocking: true,
    attachment_ids: ["attachment-1"],
    grouped_decisions: [
      { id: first.id, blocking: false },
      { id: second.id, blocking: true, attachment_ids: ["attachment-1"] },
    ],
  });
  expect(items[0]?.context).toContain("阻塞工作");
  expect(items[0]?.context).toContain("attachment-1");
  expect(f.state.decisions.find((q) => q.id === first.id)?.blocking).toBe(
    false,
  );
  expect(f.state.decisions.find((q) => q.id === other.id)?.decider).toBe(
    "role:pm",
  );
  const answered = value(
    recordDecision(
      f.state,
      human,
      {
        decision_id: first.id,
        option: "no",
        rationale: "暂不执行",
        raw_quote: "暂停",
      },
      f.p,
    ),
  );
  f.state = apply(f.state, answered);
  expect(f.state.decisions.find((q) => q.id === second.id)?.status).toBe(
    "open",
  );
  expect(
    value(listNeedsYou(f.state, human, f.p.clock)).data.decisions.map(
      (q) => q.id,
    ),
  ).toEqual([second.id]);
});

test("authorized ordinary questions retain PM resolution, sensitive questions do not gain authority", () => {
  const f = setup();
  const q = f.request("general");
  expect(
    resolveDelegatedDecision(
      f.state,
      actor(4, "pm"),
      { decision_id: q.id, option: "no", rationale: "按既有权限处理" },
      f.p,
    ).ok,
  ).toBe(true);
  f.state = {
    ...f.state,
    cards: f.state.cards.map((c) =>
      c.id === q.card_id ? { ...c, sensitive: true } : c,
    ),
  };
  expect(
    resolveDelegatedDecision(
      f.state,
      actor(4, "pm"),
      { decision_id: q.id, option: "no", rationale: "尝试处理" },
      f.p,
    ).ok,
  ).toBe(false);
});

function producerState(): CommandState {
  const f = fixture();
  const employee: Employee = {
    id: id("employee", 1),
    name: "作者",
    title: "开发",
    bio: "",
    avatar: null,
    role_id: "coder",
    launch_profile_ref: null,
    status: "active",
    created_at: now,
    updated_at: now,
  };
  return {
    ...f,
    cards: f.cards.map((c) => ({ ...c, status: "todo" })),
    assignments: [],
    runs: [],
    employees: [employee],
    work_items: f.work_items.map(({ assignment_id: _a, ...w }) =>
      w.kind === "produce" ? { ...w, status: "todo" } : w,
    ),
  };
}
const auto = (s: CommandState, caller = system) =>
  value(
    autoAssignProducer(
      s,
      caller,
      { work_item_id: id("work_item", 1) },
      ports(),
    ),
  );

test("first producer selects a qualified employee and never creates a second persistent assignment", () => {
  const state = producerState();
  const effect = auto(state);
  expect(effect.data?.employee_id).toBe(id("employee", 1));
  expect(effect.events[0]?.payload).toMatchObject({
    first_producer: true,
    assigned_by: "system",
  });
  expect(effect.token_requests).toHaveLength(1);
  expect(auto(apply(state, effect)).data).toBeNull();
  expect(
    autoAssignProducer(
      state,
      actor(),
      { work_item_id: id("work_item", 1) },
      ports(),
    ).ok,
  ).toBe(false);
});

test("automatic first producer skips the idle remote worker for worktree roles and defers if local cannot run", () => {
  const base = producerState();
  const available: MachinePlacement = {
    remote_binding: "allowed",
    observation_target_matches: true,
    health: { status: "passed", available: true },
    capabilities: [{ key: "harness.codex", version: "1.2.3", available: true }],
    occupied: 0,
    limit: 4,
  };
  const remote = {
    ...machine(),
    id: "remote-a",
    herdr_machine: "remote-a",
    tags: ["gpu"],
  };
  const state: CommandState = {
    ...base,
    roles: base.roles.map((r) => ({ ...r, worktree: "write" })),
    machines: [remote, machine()],
    read_machine_placement: () =>
      placement([
        [remote.id, available],
        ["local", { ...available, occupied: 3 }],
      ]),
  };
  const effect = auto(state);
  expect(effect.data?.machine_id).toBe("local");
  expect(effect.events.at(-1)).toMatchObject({
    type: "machine_selected",
    payload: {
      excluded: [
        {
          machine_id: remote.id,
          reasons: [expect.stringContaining("远程 Git 工作树准备尚未验证")],
        },
      ],
    },
  });
  const verified = auto({
    ...state,
    read_machine_placement: () =>
      placement([
        [remote.id, { ...available, worktree_preparation: "verified" }],
        ["local", { ...available, occupied: 3 }],
      ]),
  });
  expect(verified.data?.machine_id).toBe(remote.id);
  const gap = auto({
    ...state,
    work_items: state.work_items.map((w) => ({
      ...w,
      requirements: { tags: ["gpu"] },
    })),
  });
  expect(gap.data).toBeNull();
  expect(gap.token_requests).toEqual([]);
  expect(gap.changes).toEqual([]);
  expect(gap.events).toMatchObject([
    {
      type: "system_assignment_deferred",
      payload: {
        reason: expect.stringContaining("远程 Git 工作树准备尚未验证"),
      },
    },
  ]);
});

test.each([
  "backlog",
  "manual",
  "dependency",
  "historical",
  "blocked",
  "cancelled",
])("first producer respects %s", (scenario) => {
  let state = producerState();
  if (scenario === "backlog")
    state = {
      ...state,
      cards: state.cards.map((c) => ({ ...c, status: "backlog" })),
    };
  if (scenario === "historical")
    state = {
      ...state,
      assignments: [{ ...assignment(), status: "released" }],
    };
  if (["manual", "dependency", "blocked", "cancelled"].includes(scenario))
    state = {
      ...state,
      work_items: state.work_items.map((w) =>
        w.kind === "produce"
          ? {
              ...w,
              ...(scenario === "manual" ? { manual_assign: true } : {}),
              ...(scenario === "dependency"
                ? { depends_on: [id("work_item", 2)] }
                : {}),
              ...(scenario === "blocked" || scenario === "cancelled"
                ? { status: scenario }
                : {}),
            }
          : w,
      ),
    };
  expect(auto(state).events).toHaveLength(0);
});

test("no eligible employee leaves a durable exception once and can recover when candidates change", () => {
  const state = { ...producerState(), employees: [] };
  const failed = auto(state);
  expect(failed.events[0]?.type).toBe("system_assignment_deferred");
  const retried = apply(state, failed);
  expect(auto(retried).events).toHaveLength(0);
  expect(
    auto({ ...retried, employees: producerState().employees ?? [] }).data,
  ).not.toBeNull();
});

test.each([
  { label: "body", body: "请 @A-5 处理本次配置，并回复原请求。", mentions: [] },
  { label: "bare explicit", body: "请处理本次配置", mentions: ["A-5"] },
  { label: "prefixed explicit", body: "请处理本次配置", mentions: ["@A-5"] },
  { label: "mixed", body: "请 @A-5 处理本次配置", mentions: ["A-5", "@A-5"] },
])(
  "Office wait with $label mentions tracks, warns once and closes on reply",
  ({ body, mentions }) => {
    const f = setup();
    f.tick();
    f.advance(1000);
    const request = f.comment(body, actor(4, "pm"), undefined, mentions);
    expect(f.tick().events.map((e) => e.type)).toEqual(["office_wait_started"]);
    expect(f.tick().events).toHaveLength(0);
    expect(notices(f.state).map((n) => n.option)).toEqual(["等待 PM Office"]);
    f.advance(OFFICE_WAIT_MS);
    expect(f.tick().events).toHaveLength(0);
    f.advance(1);
    expect(f.tick().events.map((e) => e.type)).toEqual(["office_wait_overdue"]);
    expect(f.tick().events).toHaveLength(0);
    f.comment("已处理", actor(5, "pm"), request.id);
    expect(f.tick().events.map((e) => e.type)).toEqual(["office_wait_closed"]);
    f.advance(OFFICE_WAIT_MS);
    expect(f.tick().events).toHaveLength(0);
    expect(notices(f.state)).toHaveLength(0);
  },
);

test("C-415: cached histories keep time boundaries, new replies and retractions fresh", () => {
  const f = setup();
  f.tick();
  const request = f.comment("请 Office 跟进", actor(4, "pm"), undefined, [
    f.office.id,
  ]);
  f.tick();
  const waiting = f.state;
  const evaluate = (state: CommandState) =>
    value(maintainPmCoordination(state, system, f.p)).events.map((e) => e.type);
  expect(evaluate(waiting)).toEqual([]);
  f.advance(OFFICE_WAIT_MS);
  expect(evaluate(waiting)).toEqual([]);
  f.advance(1);
  expect(evaluate(waiting)).toEqual(["office_wait_overdue"]);
  const reply = f.comment("收到", actor(5, "pm"), request.id);
  const answered = f.state;
  expect(evaluate(answered)).toEqual(["office_wait_closed"]);
  const retracted = {
    ...answered,
    timeline: answered.timeline.map((t) =>
      t.id === reply.id ? { ...t, retracted: true } : t,
    ),
  };
  expect(evaluate(retracted)).toEqual(["office_wait_overdue"]);
  // A rolled-back reply/retraction must not poison either earlier snapshot.
  expect(evaluate(waiting)).toEqual(["office_wait_overdue"]);
  expect(evaluate(answered)).toEqual(["office_wait_closed"]);
});

test("Office replies before deadline and closed cards never create an overdue reminder", () => {
  const f = setup();
  f.tick();
  f.advance(1000);
  const request = f.comment("请 @A-5 核对");
  f.tick();
  f.comment("收到并已答复", actor(5, "pm"), request.id);
  f.advance(OFFICE_WAIT_MS + 1);
  f.tick();
  expect(f.state.events.some((e) => e.type === "office_wait_overdue")).toBe(
    false,
  );
});

test("recovery preserves standing identity and questions; stale observation and repeated ticks cannot restart", () => {
  const f = setup();
  const q = f.request();
  const p = { assignment: f.ops, runs: [], held_run_ids: [], exited: true };
  expect(pmRecoveryEligible(f.state, f.ops)).toBe(true);
  expect(recoverStandingPm(f.state, actor(), p, f.p).ok).toBe(false);
  expect(
    value(recoverStandingPm(f.state, system, { ...p, exited: false }, f.p))
      .data,
  ).toBe(false);
  const effect = value(recoverStandingPm(f.state, system, p, f.p));
  f.state = apply(f.state, effect);
  expect(f.state.assignments.find((a) => a.id === f.ops.id)?.status).toBe(
    "active",
  );
  expect(f.state.decisions.find((v) => v.id === q.id)).toMatchObject({
    id: q.id,
    decider: "role:pm",
    status: "open",
  });
  expect(
    notices(f.state).some((n) => n.option === "常驻 PM 已安排自动恢复"),
  ).toBe(true);
  expect(value(recoverStandingPm(f.state, system, p, f.p)).data).toBe(false);
});

test.each(["paused", "external", "busy", "stopping", "changed"])(
  "recovery rejects %s standing context",
  (scenario) => {
    const f = setup();
    const before = {
      assignment: f.ops,
      runs: [],
      held_run_ids: [],
      exited: true,
    };
    if (
      scenario === "paused" ||
      scenario === "external" ||
      scenario === "changed"
    )
      f.state = {
        ...f.state,
        assignments: f.state.assignments.map((a) =>
          a.id === f.ops.id
            ? {
                ...a,
                ...(scenario === "paused"
                  ? { status: "suspended" as const }
                  : {}),
                ...(scenario === "external" ? { external: true } : {}),
                ...(scenario === "changed"
                  ? { session_ref: "new-session" }
                  : {}),
              }
            : a,
        ),
      };
    if (scenario === "busy" || scenario === "stopping")
      f.state = {
        ...f.state,
        runs: [
          ...f.state.runs,
          {
            ...run(9, 4),
            id: id("run", 9),
            assignment_id: f.ops.id,
            status: "queued",
          },
        ],
      };
    expect(value(recoverStandingPm(f.state, system, before, f.p)).data).toBe(
      false,
    );
  },
);

test("a blocking author question resumes only after an authorized PM answer and never reopens the old run", () => {
  const f = setup();
  const requested = value(
    requestDecision(
      f.state,
      actor(),
      {
        card_id: id("card", 1),
        category: "general",
        kind: "choose",
        question: "如何继续",
        context: "实现细节待定",
        options: [{ key: "go", description: "继续", impact: "采用默认方案" }],
        recommended: "go",
        affected_cards: [],
        affected_work_items: [],
        blocking: true,
        decider: "role:pm",
      },
      f.p,
    ),
  );
  f.state = apply(f.state, requested);
  expect(
    f.state.work_items.find((w) => w.id === id("work_item", 1))?.status,
  ).toBe("waiting_decision");
  const answer = value(
    resolveDelegatedDecision(
      f.state,
      actor(4, "pm"),
      {
        decision_id: requested.data.id,
        option: "go",
        rationale: "在既有授权内",
      },
      f.p,
    ),
  );
  f.state = apply(f.state, answer);
  expect(f.state.runs.find((r) => r.id === id("run", 1))?.status).toBe(
    "completed",
  );
  expect(
    f.state.runs.filter(
      (r) => r.assignment_id === id("assignment", 1) && r.status === "queued",
    ),
  ).toHaveLength(1);
});

test("external host handoffs wait on Office and stop reminding after its linked reply", () => {
  const f = setup();
  f.tick();
  f.advance(1000);
  const action = value(
    requestHumanAction(
      f.state,
      actor(),
      {
        card_id: id("card", 1),
        instructions: "请检查外部配置",
        why_human: "外接操作员负责",
        expected_return: "检查结论",
        blocked_work_items: [],
      },
      f.p,
    ),
  );
  f.state = apply(f.state, action);
  f.state = apply(
    f.state,
    value(
      triageHumanAction(
        f.state,
        actor(4, "pm"),
        {
          human_action_id: action.data.id,
          disposition: "host",
          host_operator: "external",
          host_assignment_id: f.office.id,
          rationale: "交给外接操作员",
          title: "检查外部配置",
          summary: "检查运行参数",
          why_human: "需要外接权限",
          expected_outcome: "确认配置有效",
          instructions: "检查配置",
          expected_return: "回传结果",
        },
        f.p,
      ),
    ),
  );
  expect(f.tick().events.map((e) => e.type)).toEqual(["office_wait_started"]);
  f.advance(OFFICE_WAIT_MS + 1);
  expect(f.tick().events.map((e) => e.type)).toEqual(["office_wait_overdue"]);
  expect(notices(f.state)).toHaveLength(1);
  f.comment(`已收到 ${action.data.id}，正在处理`, actor(5, "pm"));
  expect(f.tick().events.map((e) => e.type)).toEqual(["office_wait_closed"]);
  expect(f.tick().events).toHaveLength(0);
});
