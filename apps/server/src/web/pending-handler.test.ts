import {
  type CommandState,
  completeHumanAction,
  requestHumanAction,
} from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  apply,
  fixture,
  human,
  id,
  ports,
  actor as testActor,
  value,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import { cardDetail, needsYou, needsYouCounts } from "./read.js";

const NOW = "2026-01-02T00:00:00.000Z";

/** C-822: the owner's action and 张良's, on the same card. */
function scene() {
  const ids = ports();
  let state: CommandState = fixture();
  const request = (instructions: string) => {
    const effect = value(
      requestHumanAction(
        state,
        testActor(1, "coder"),
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
    state = apply(state, effect);
    return effect.data;
  };
  const owner = request("请登录 GitHub");
  const operator = request("张良：换主机运维会话");
  return { state, owner, operator };
}

const handlers = (state: CommandState) => {
  const detail = cardDetail(state, id("card", 1));
  if (!detail) throw new Error("missing card");
  return {
    waiting: detail.card.waiting_on
      .filter((w) => w.kind === "human_action")
      .map((w) => [w.ref, w.handler]),
    timeline: detail.timeline
      .filter((e) => e.type === "human_action")
      .map((e) => [e.human_action_id, e.body, e.human_action_handler])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    needs: needsYou(state, NOW).human_actions.map((h) => [h.id, h.handler]),
    counts: needsYouCounts(state, NOW),
  };
};

test("Needs You, the card's waiting list and its timeline read one handler and change together", () => {
  const { state, owner, operator } = scene();
  const before = handlers(state);
  expect(before.waiting).toEqual([
    [owner.id, "owner"],
    [operator.id, "operator"],
  ]);
  expect(before.timeline).toEqual(
    [
      [owner.id, "请登录 GitHub", "owner"],
      [operator.id, "交给张良：张良：换主机运维会话", "operator"],
    ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
  );
  expect(before.needs).toEqual([
    [owner.id, "owner"],
    [operator.id, "operator"],
  ]);
  expect(before.counts.total_pending).toBe(1);
  expect(before.counts.tabs.actions).toEqual({ count: 2, attention: 1 });

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
  const after = handlers(done);
  expect(after.waiting).toEqual([[operator.id, "operator"]]);
  expect(after.timeline).toEqual(
    [
      [owner.id, "请登录 GitHub", "done"],
      [operator.id, "交给张良：张良：换主机运维会话", "operator"],
      [owner.id, "已登录", "done"],
    ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
  );
  expect(after.needs).toEqual([[operator.id, "operator"]]);
  expect(after.counts.total_pending).toBe(0);
  expect(after.counts.tabs.actions).toEqual({ count: 1, attention: 0 });
});
