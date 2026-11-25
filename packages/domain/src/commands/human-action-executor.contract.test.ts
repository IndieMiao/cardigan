import { expect, test } from "vitest";
import type { Actor, Assignment, HumanAction } from "../entities.js";
import {
  classifyHumanActionExecutor,
  completeHumanAction,
  deriveCardFields,
  extMessageItems,
  inferHumanActionExecutor,
  listNeedsYou,
  listNeedsYouCounts,
  reassignHumanAction,
  requestHumanAction,
  triageHumanAction,
} from "../index.js";
import type { CommandState } from "./core.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  ports,
  value,
} from "./test-fixtures.js";

const office = actor(4, "pm");
const coder = actor(1, "coder");
const clock = { now: () => "2026-01-02T00:00:00.000Z" };

/** A-4 is the project's external PM Office, i.e. the operator's identity. */
function setup(): CommandState {
  const state = fixture();
  return {
    ...state,
    assignments: state.assignments.map(
      (a): Assignment =>
        a.id === id("assignment", 4) && a.scope === "standing"
          ? { ...a, standing_mode: "office", external: true }
          : a,
    ),
  };
}
function request(
  state: CommandState,
  p: Partial<Parameters<typeof requestHumanAction>[2]> = {},
  by: Actor = coder,
  idPorts = ports(),
) {
  const effect = value(
    requestHumanAction(
      state,
      by,
      {
        card_id: id("card", 1),
        instructions: "张良：换主机运维会话",
        why_human: "需要人执行",
        expected_return: "新会话编号",
        blocked_work_items: [],
        ...p,
      },
      idPorts,
    ),
  );
  return { state: apply(state, effect), action: effect.data, effect };
}
const complete = (
  state: CommandState,
  by: Actor,
  action: HumanAction,
  extra: { as_operator?: true } = {},
) =>
  completeHumanAction(
    state,
    by,
    { human_action_id: action.id, text: "已换会话", ...extra },
    ports(),
  );

test("rule 1: the 张良 title prefix or an operator-only reason defaults to operator; explicit wins", () => {
  const owner = { instructions: "请登录 GitHub", why_human: "需要所有者账号" };
  expect(inferHumanActionExecutor(owner)).toBe("owner");
  for (const instructions of [
    "张良：停卡住会话",
    "张良:换会话",
    "  张良 ：上传",
    "\n张良：第一行为标题\n第二行",
  ])
    expect(inferHumanActionExecutor({ ...owner, instructions })).toBe(
      "operator",
    );
  for (const why_human of [
    "要在主机上执行",
    "要替换凭据文件",
    "需要 oss 上传",
    "上传到 OSS。",
    "送签批准只能人操作",
    "要用云助手",
  ])
    expect(inferHumanActionExecutor({ ...owner, why_human })).toBe("operator");
  expect(inferHumanActionExecutor({ ...owner, title: "张良：改写后" })).toBe(
    "operator",
  );
  expect(
    inferHumanActionExecutor({ ...owner, instructions: "请张良：中间不算" }),
  ).toBe("owner");
  // Latin keywords must stand alone.
  for (const why_human of [
    "Not possible for agents",
    "loss of data",
    "across machines",
    "Bossy",
  ])
    expect(inferHumanActionExecutor({ ...owner, why_human })).toBe("owner");

  expect(
    classifyHumanActionExecutor({ ...owner, why_human: "要用云助手" }),
  ).toEqual({ executor: "operator", basis: "keyword:云助手" });
  const base = setup();
  expect(request(base).action.executor).toBe("operator");
  expect(
    request(base, { executor: "owner" }).effect.events[0]?.payload,
  ).toMatchObject({ executor: "owner", executor_basis: "explicit" });
  expect(request(base, { executor: "owner" }).action.executor).toBeUndefined();
  expect(
    request(base, { instructions: "请登录", executor: "operator" }).action
      .executor,
  ).toBe("operator");
  expect(
    request(base, { instructions: "请登录" }).action.executor,
  ).toBeUndefined();
  expect(
    requestHumanAction(
      base,
      coder,
      {
        card_id: id("card", 1),
        instructions: "x",
        why_human: "y",
        expected_return: "z",
        blocked_work_items: [],
        executor: "someone" as "owner",
      },
      ports(),
    ).ok,
  ).toBe(false);
});

test("an operator action writes the operator's event and never reaches the owner's push or count", () => {
  const ids = ports();
  const { state, action, effect } = request(setup(), {}, coder, ids);
  expect(effect.events.map((e) => e.type)).toEqual([
    "human_action_requested",
    "operator_action_requested",
  ]);
  expect(effect.events[0]?.payload).toMatchObject({
    executor: "operator",
    executor_basis: "title",
  });
  expect(effect.events[1]?.payload).toMatchObject({
    human_action_id: action.id,
    executor: "operator",
    reason: "requested",
    executor_basis: "title",
    title: "张良：换主机运维会话",
    expected_return: "新会话编号",
  });

  const owner = request(state, { instructions: "请登录 GitHub" }, coder, ids);
  const both = owner.state;
  expect(owner.effect.events.map((e) => e.type)).toEqual([
    "human_action_requested",
  ]);
  expect(owner.effect.events[0]?.payload).toMatchObject({
    executor: "owner",
    executor_basis: "default",
  });

  const items = extMessageItems(both, both.project_id).filter(
    (i) => i.kind === "human_action",
  );
  expect(items.map((i) => i.item_id)).toEqual([owner.action.id]);

  const counts = value(listNeedsYouCounts(both, human, clock)).data;
  expect(counts.total_pending).toBe(1);
  expect(counts.tabs.actions.attention).toBe(1);
  // Still listed so the Workbench can show it as “交给张良”.
  const listed = value(listNeedsYou(both, human, clock)).data.human_actions;
  expect(listed.map((h) => [h.id, h.executor])).toEqual([
    [action.id, "operator"],
    [owner.action.id, undefined],
  ]);

  const card = both.cards.find((c) => c.id === id("card", 1));
  if (!card) throw new Error("missing card");
  expect(
    deriveCardFields({ ...both, card } as never).waiting_on.map((w) => w.label),
  ).toEqual(
    expect.arrayContaining([
      `等待张良执行 ${action.id}`,
      `等你执行 ${owner.action.id}`,
    ]),
  );
});

test("only the operator identity or the operator-marked human CLI completes an operator action", () => {
  const { state, action } = request(setup());
  // Owner surfaces (web, Feishu) complete as a plain human.
  expect(complete(state, human, action)).toMatchObject({
    ok: false,
    error: { code: "unauthorized" },
  });
  // Other Agents, including an internal PM, cannot close it either.
  expect(complete(state, coder, action).ok).toBe(false);
  const internal: CommandState = {
    ...state,
    assignments: state.assignments.map((a) =>
      a.id === id("assignment", 4) ? { ...a, external: false } : a,
    ),
  };
  expect(complete(internal, office, action).ok).toBe(false);
  // The operator flag is a human CLI marker only.
  expect(complete(state, office, action, { as_operator: true }).ok).toBe(false);

  const byOffice = value(complete(state, office, action));
  expect(byOffice.data.status).toBe("done");
  const byCli = value(complete(state, human, action, { as_operator: true }));
  expect(byCli.data.status).toBe("done");

  // A role version without the completion tool is not the operator.
  const noTool: CommandState = {
    ...state,
    roles: state.roles.map((r) =>
      r.role_id === "pm"
        ? {
            ...r,
            allowed_tools: r.allowed_tools.filter(
              (t) => t !== "complete_host_action",
            ),
          }
        : r,
    ),
  };
  expect(complete(noTool, office, action).ok).toBe(false);
});

test("PM Ops cannot close an operator action through triage", () => {
  const base = setup();
  const { work_item_id: _unused, ...rest } = {
    ...base.assignments.find((a) => a.id === id("assignment", 3)),
  } as Extract<Assignment, { scope: "work_item" }>;
  const ops: Assignment = {
    ...rest,
    id: id("assignment", 5),
    scope: "standing",
    standing_mode: "ops",
  };
  const state: CommandState = {
    ...base,
    assignments: [...base.assignments, ops],
  };
  const { state: next, action } = request(state);
  expect(action.triage).toBe("pm_ops");
  expect(action.executor).toBe("operator");
  const ops5 = actor(5, "pm");
  expect(
    triageHumanAction(
      next,
      ops5,
      { human_action_id: action.id, disposition: "done", rationale: "已处理" },
      ports(),
    ).ok,
  ).toBe(false);

  // Rewrites keep the executor unless PM Ops hands it to internal host ops.
  const rewrite = {
    human_action_id: action.id,
    rationale: "改写",
    title: "张良：换会话",
    summary: "换会话",
    why_human: "要在主机上执行",
    instructions: "换会话",
    expected_outcome: "新会话",
    expected_return: "新会话编号",
  };
  const toHuman = value(
    triageHumanAction(
      next,
      ops5,
      { ...rewrite, disposition: "human" },
      ports(),
    ),
  );
  expect(toHuman.data.executor).toBe("operator");
  const external = value(
    triageHumanAction(
      next,
      ops5,
      {
        ...rewrite,
        disposition: "host",
        host_operator: "external",
        host_assignment_id: id("assignment", 4),
      },
      ports(),
    ),
  );
  expect(external.data.executor).toBe("operator");
  const internal = value(
    triageHumanAction(
      next,
      ops5,
      { ...rewrite, disposition: "host", host_operator: "host_ops" },
      ports(),
    ),
  );
  expect(internal.data.executor).toBeUndefined();
  expect(internal.events[0]?.payload).toMatchObject({
    previous_executor: "operator",
  });
});

test("an internal host-ops handoff cannot be reassigned to 张良", () => {
  const { state, action } = request(setup(), { executor: "owner" });
  const handed = (patch: Partial<HumanAction>): CommandState => ({
    ...state,
    human_actions: state.human_actions.map((h) =>
      h.id === action.id ? { ...h, triage: "host", ...patch } : h,
    ),
  });
  const toOperator = (s: CommandState) =>
    reassignHumanAction(
      s,
      human,
      { human_action_id: action.id, executor: "operator", reason: "交给张良" },
      ports(),
    );
  expect(toOperator(handed({ host_operator: "host_ops" }))).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
  expect(
    value(toOperator(handed({ host_operator: "external" }))).data.executor,
  ).toBe("operator");
});

test("system-raised actions cannot be reassigned", () => {
  const { state, action } = request(setup());
  const system: CommandState = {
    ...state,
    human_actions: state.human_actions.map((h) =>
      h.id === action.id ? { ...h, requested_by: "system" } : h,
    ),
  };
  expect(
    reassignHumanAction(
      system,
      human,
      { human_action_id: action.id, executor: "owner", reason: "自己来" },
      ports(),
    ),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
});

test("the owner can take an operator action back, and handing it to the operator notifies again", () => {
  const { state, action } = request(setup());
  const reassign = (
    s: CommandState,
    executor: "owner" | "operator",
    by: Actor = human,
  ) =>
    reassignHumanAction(
      s,
      by,
      { human_action_id: action.id, executor, reason: "所有者改为自己处理" },
      ports(),
    );
  expect(reassign(state, "owner", coder).ok).toBe(false);
  expect(
    reassignHumanAction(
      state,
      human,
      { human_action_id: action.id, executor: "owner", reason: " " },
      ports(),
    ).ok,
  ).toBe(false);

  const back = value(reassign(state, "owner"));
  expect(back.data.executor).toBeUndefined();
  expect(back.events.map((e) => e.type)).toEqual(["human_action_reassigned"]);
  expect(back.events[0]?.payload).toMatchObject({
    previous_executor: "operator",
    executor: "owner",
  });
  const owned = apply(state, back);
  expect(
    value(listNeedsYouCounts(owned, human, clock)).data.total_pending,
  ).toBe(1);
  expect(
    extMessageItems(owned, owned.project_id).map((i) => i.item_id),
  ).toContain(action.id);
  expect(value(complete(owned, human, action)).data.status).toBe("done");
  // Unchanged executor: no event.
  expect(value(reassign(owned, "owner")).events).toEqual([]);

  const again = value(reassign(owned, "operator", office));
  expect(again.data.executor).toBe("operator");
  expect(again.events.map((e) => e.type)).toEqual([
    "human_action_reassigned",
    "operator_action_requested",
  ]);
  expect(again.events[1]?.payload).toMatchObject({
    reason: "reassigned",
    executor_basis: "reassigned",
  });

  const done = apply(owned, value(complete(owned, human, action)));
  expect(reassign(done, "operator").ok).toBe(false);
});
