import { expect, test } from "vitest";
import type { Assignment, HumanAction } from "../entities.js";
import {
  completeHumanAction,
  decisionHandler,
  deriveCardFields,
  humanActionHandler,
  listNeedsYou,
  listNeedsYouCounts,
  requestHumanAction,
  waitsOnOwner,
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

const coder = actor(1, "coder");
const clock = { now: () => "2026-01-02T00:00:00.000Z" };

/** A-4 is the project's external PM Office, i.e. 张良's identity. */
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

/** One id source per scene, so each request gets its own H-n. */
let ids = ports();
function request(state: CommandState, instructions: string) {
  const effect = value(
    requestHumanAction(
      state,
      coder,
      {
        card_id: id("card", 1),
        instructions,
        why_human: "需要人执行",
        expected_return: "结果",
        blocked_work_items: [],
      },
      ids,
    ),
  );
  return { state: apply(state, effect), action: effect.data };
}

const patch = (
  state: CommandState,
  action: HumanAction,
  change: Partial<HumanAction>,
): CommandState => ({
  ...state,
  human_actions: state.human_actions.map((h) =>
    h.id === action.id ? { ...h, ...change } : h,
  ),
});

/** The owner's action, 张良's, one in PM triage (H-132) and a host action. */
function scene() {
  ids = ports();
  let state = setup();
  const owner = request(state, "请登录 GitHub");
  state = owner.state;
  const operator = request(state, "张良：换主机运维会话");
  state = operator.state;
  const triage = request(state, "张良：核对中转线路");
  state = patch(triage.state, triage.action, { triage: "pm_ops" });
  const host = request(state, "重启主机进程");
  state = patch(host.state, host.action, {
    triage: "host",
    host_operator: "host_ops",
  });
  return {
    state,
    owner: owner.action,
    operator: operator.action,
    triage: triage.action,
    host: host.action,
  };
}

function card(state: CommandState) {
  const c = state.cards.find((x) => x.id === id("card", 1));
  if (!c) throw new Error("missing card");
  return deriveCardFields({ ...state, card: c } as never);
}

test("one answer for who handles an item: PM triage first, then 张良, host ops or the owner", () => {
  const open = { status: "open" } as const;
  expect(humanActionHandler(open)).toBe("owner");
  expect(humanActionHandler({ ...open, executor: "operator" })).toBe(
    "operator",
  );
  // H-132: 张良's action still in PM triage is PM's for now.
  expect(
    humanActionHandler({ ...open, executor: "operator", triage: "pm_ops" }),
  ).toBe("pm");
  expect(humanActionHandler({ ...open, triage: "host" })).toBe("host");
  expect(humanActionHandler({ ...open, triage: "human" })).toBe("owner");
  for (const status of ["done", "cancelled"] as const)
    expect(humanActionHandler({ status, executor: "operator" })).toBe("done");

  expect(decisionHandler({ status: "open", decider: "human" })).toBe("owner");
  expect(decisionHandler({ status: "snoozed", decider: "human" })).toBe(
    "owner",
  );
  expect(decisionHandler({ status: "open", decider: "role:pm" })).toBe("pm");
  expect(decisionHandler({ status: "open", decider: "system" })).toBe("system");
  expect(decisionHandler({ status: "resolved", decider: "human" })).toBe(
    "done",
  );
});

test("Needs You counts, the card's waiting list and its next owners give the owner the same one item", () => {
  const { state, owner, operator, triage, host } = scene();

  const counts = value(listNeedsYouCounts(state, human, clock)).data;
  expect(counts.total_pending).toBe(1);
  expect(counts.tabs.actions.attention).toBe(1);
  // 张良's and the host action are listed apart; PM triage is not listed.
  expect(counts.tabs.actions.count).toBe(3);

  const listed = value(listNeedsYou(state, human, clock)).data.human_actions;
  expect(listed.map((h) => [h.id, h.handler])).toEqual([
    [owner.id, "owner"],
    [operator.id, "operator"],
    [host.id, "host"],
  ]);

  const fields = card(state);
  expect(
    fields.waiting_on
      .filter((w) => w.kind === "human_action")
      .map((w) => [w.ref, w.handler, w.label]),
  ).toEqual([
    [owner.id, "owner", `等你执行 ${owner.id}`],
    [operator.id, "operator", `等待张良执行 ${operator.id}`],
    [triage.id, "pm", `等待 PM 分拣 ${triage.id}`],
    [host.id, "host", `等待主机操作 ${host.id}`],
  ]);
  expect(fields.waiting_on.filter(waitsOnOwner).map((w) => w.ref)).toEqual([
    owner.id,
  ]);
  expect(fields.next_owners).toEqual(
    expect.arrayContaining([
      { kind: "human", ref: "human" },
      { kind: "role", ref: "pm" },
      { kind: "role", ref: "host_ops" },
    ]),
  );
});

test("an item nobody gave the owner never makes the owner the card's next owner", () => {
  const { state, owner } = scene();
  const without = {
    ...state,
    human_actions: state.human_actions.filter((h) => h.id !== owner.id),
  };
  expect(card(without).next_owners).not.toContainEqual({
    kind: "human",
    ref: "human",
  });
  expect(card(without).waiting_on.some(waitsOnOwner)).toBe(false);
  expect(value(listNeedsYouCounts(without, human, clock)).data).toMatchObject({
    total_pending: 0,
    tabs: { actions: { attention: 0 } },
  });
});

test("completing the owner's action changes Needs You, the card and its timeline in the same state", () => {
  const { state, owner } = scene();
  const entries = (s: CommandState) =>
    s.timeline.filter((e) => e.human_action_id === owner.id);
  expect(entries(state)).toHaveLength(1);

  const done = apply(
    state,
    value(
      completeHumanAction(
        state,
        human,
        { human_action_id: owner.id, text: "已登录" },
        ports(),
      ),
    ),
  );
  const action = done.human_actions.find((h) => h.id === owner.id);
  if (!action) throw new Error("missing action");
  expect(humanActionHandler(action)).toBe("done");

  expect(value(listNeedsYouCounts(done, human, clock)).data).toMatchObject({
    total_pending: 0,
    tabs: { actions: { count: 2, attention: 0 } },
  });
  expect(
    value(listNeedsYou(done, human, clock)).data.human_actions.map((h) => h.id),
  ).not.toContain(owner.id);
  const fields = card(done);
  expect(fields.waiting_on.map((w) => w.ref)).not.toContain(owner.id);
  expect(fields.waiting_on.some(waitsOnOwner)).toBe(false);
  expect(fields.next_owners).not.toContainEqual({
    kind: "human",
    ref: "human",
  });
  expect(entries(done).map((e) => [e.type, e.body])).toEqual([
    ["human_action", "请登录 GitHub"],
    ["human_action", "已登录"],
  ]);
});

test("an internal host action names host ops, or the operator it was handed to", () => {
  const { state, host } = scene();
  const handed = patch(state, host, {
    host_assignment_id: id("assignment", 4),
  });
  expect(card(handed).next_owners).toContainEqual({
    kind: "assignment",
    ref: id("assignment", 4),
  });
  const external = patch(state, host, { host_operator: "external" });
  expect(card(external).next_owners).not.toContainEqual({
    kind: "role",
    ref: "host_ops",
  });
});
