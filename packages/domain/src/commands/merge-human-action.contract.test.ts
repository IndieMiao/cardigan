import { expect, test } from "vitest";
import type { Decision, HumanAction } from "../index.js";
import {
  completeHumanAction,
  mergePlan,
  prepareMergePlan,
  recordDecision,
  requestHumanAction,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human, id } from "./test-fixtures.js";

async function awaitingMerge() {
  const f = mergeFixture();
  await f.accept();
  expect(f.card.id).toBe(f.state.cards[0]?.id);
  expect(f.state.cards[0]?.status).toBe("awaiting_merge");
  return f;
}
function confirm(f: Awaited<ReturnType<typeof awaitingMerge>>) {
  const q = f.state.decisions.find(
    (d) => d.trigger === "merge_confirmation",
  ) as Decision;
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option: "merge",
        rationale: "Approved",
        raw_quote: "Merge",
      },
      f.io,
    ),
  );
}
function ask(
  f: Awaited<ReturnType<typeof awaitingMerge>>,
  extra: { blocks_merge?: boolean } = {},
) {
  return f.commit(
    requestHumanAction(
      f.state,
      human,
      {
        card_id: f.card.id,
        instructions: "请在主机上查看合并检查日志",
        why_human: "只有主机能看日志",
        expected_return: "日志摘要",
        blocked_work_items: [],
        ...extra,
      },
      f.io,
    ),
  );
}

test("C-112: a read-only human action on the card does not hold prepareMergePlan or mergePlan", async () => {
  const f = await awaitingMerge();
  const action = ask(f);
  expect(action.blocks_merge).toBeUndefined();
  expect(action.status).toBe("open");
  expect(prepareMergePlan(f.state, f.card.id).ok).toBe(true);
  confirm(f);
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test("C-112: a human action raised with blocks_merge holds the merge and names itself until done", async () => {
  const f = await awaitingMerge();
  const action = ask(f, { blocks_merge: true });
  expect(action.blocks_merge).toBe(true);
  expect(
    f.state.events.find((e) => e.type === "human_action_requested")?.payload,
  ).toMatchObject({ human_action_id: action.id, blocks_merge: true });
  confirm(f);
  for (const plan of [prepareMergePlan, mergePlan])
    expect(plan(f.state, f.card.id)).toMatchObject({
      ok: false,
      error: {
        code: "illegal_transition",
        message: expect.stringContaining(action.id),
      },
    });
  f.commit(
    completeHumanAction(
      f.state,
      human,
      { human_action_id: action.id, text: "Done" },
      f.io,
    ),
  );
  expect(prepareMergePlan(f.state, f.card.id).ok).toBe(true);
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test("C-112 regression: an action blocking one of the card's work items still holds the merge", async () => {
  const f = await awaitingMerge();
  confirm(f);
  const action: HumanAction = {
    id: id("human_action", 50),
    key: id("human_action", 50),
    requested_by: "human",
    instructions: "Rotate the key",
    why_human: "Manual",
    expected_return: "Done",
    status: "open",
    blocked_work_items: [
      f.coder.work_item_id as HumanAction["blocked_work_items"][number],
    ],
  };
  const state = { ...f.state, human_actions: [action] };
  for (const plan of [prepareMergePlan, mergePlan])
    expect(plan(state, f.card.id)).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining(action.id) },
    });
  // Another card's merge-blocking action does not hold this one.
  const other = {
    ...action,
    card_id: id("card", 999),
    blocked_work_items: [],
    blocks_merge: true,
  };
  expect(mergePlan({ ...f.state, human_actions: [other] }, f.card.id).ok).toBe(
    true,
  );
});

test("C-112: an unresolved blocking decision is named in the plan error", async () => {
  const f = await awaitingMerge();
  confirm(f);
  const q = f.state.decisions[0] as Decision;
  const { trigger: _trigger, ...plain } = q;
  const blocker: Decision = {
    ...plain,
    id: id("decision", 77),
    key: id("decision", 77),
    status: "open",
    blocking: true,
  };
  expect(
    mergePlan({ ...f.state, decisions: [q, blocker] }, f.card.id),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining(blocker.id) },
  });
});
