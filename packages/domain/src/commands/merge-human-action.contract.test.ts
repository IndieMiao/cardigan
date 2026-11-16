import { expect, test } from "vitest";
import type { Decision, HumanAction } from "../index.js";
import {
  completeHumanAction,
  mergePlan,
  prepareMergePlan,
  recordDecision,
  refreshHumanActionFollowUps,
  requestHumanAction,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human, id, value } from "./test-fixtures.js";

async function awaitingMerge() {
  const f = mergeFixture();
  await f.accept();
  expect(f.card.id).toBe(f.state.cards[0]?.id);
  expect(f.state.cards[0]?.status).toBe("awaiting_merge");
  return f;
}
function confirm(
  f: Awaited<ReturnType<typeof awaitingMerge>>,
  override = false,
) {
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
        ...(override
          ? { merge_override_reason: "测试强行确认后仍须等待人工事项" }
          : {}),
        rationale: "Approved",
        raw_quote: "Merge",
      },
      f.io,
    ),
  );
}
function ask(
  f: Awaited<ReturnType<typeof awaitingMerge>>,
  extra: { blocks_merge?: boolean; prerequisite?: "external_account" } = {},
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
  const action = ask(f, {
    blocks_merge: true,
    prerequisite: "external_account" as const,
  });
  expect(action.blocks_merge).toBe(true);
  expect(
    f.state.events.find((e) => e.type === "human_action_requested")?.payload,
  ).toMatchObject({
    human_action_id: action.id,
    blocks_merge: true,
    prerequisite: "external_account" as const,
  });
  confirm(f, true);
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
    blocks_merge: true,
    prerequisite: "external_account" as const,
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
    prerequisite: "external_account" as const,
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

test("B8: field verification follows merge and does not pause referenced work", async () => {
  const f = await awaitingMerge();
  const before = f.state.work_items;
  const action = f.commit(
    requestHumanAction(
      f.state,
      human,
      {
        card_id: f.card.id,
        instructions: "Verify on the test machine after deploy",
        why_human: "Physical access",
        expected_return: "Smoke evidence",
        blocked_work_items: [f.coder.work_item_id as never],
        ready_when: { kind: "card_merged", card_id: f.card.id },
      },
      f.io,
    ),
  );
  expect(action.blocked_work_items).toEqual([]);
  expect(action.follow_up_work_items).toEqual([f.coder.work_item_id]);
  expect(f.state.work_items).toEqual(before);
  confirm(f);
  expect(prepareMergePlan(f.state, f.card.id).ok).toBe(true);
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});

test("B8: blocks_merge requires an explicit credential or external-account prerequisite", async () => {
  const f = await awaitingMerge();
  const params = {
    card_id: f.card.id,
    instructions: "Field verification",
    why_human: "Access",
    expected_return: "Evidence",
    blocked_work_items: [],
    blocks_merge: true,
  };
  expect(requestHumanAction(f.state, human, params, f.io)).toMatchObject({
    ok: false,
    error: { code: "validation_failed" },
  });
  for (const prerequisite of ["credential", "external_account"] as const) {
    const action = f.commit(
      requestHumanAction(f.state, human, { ...params, prerequisite }, f.io),
    );
    expect(action).toMatchObject({ blocks_merge: true, prerequisite });
    expect(prepareMergePlan(f.state, f.card.id).ok).toBe(false);
  }
});

test("B8: system reclassifies old implicit holds as post-merge follow-ups exactly once", async () => {
  const f = await awaitingMerge();
  const original: HumanAction = {
    id: id("human_action", 900),
    key: id("human_action", 900),
    card_id: f.card.id,
    requested_by: "human",
    instructions: "Field smoke check",
    why_human: "Physical access",
    expected_return: "Evidence",
    blocked_work_items: [f.coder.work_item_id as never],
    status: "open",
  };
  const state = { ...f.state, human_actions: [original] };
  const actor = { kind: "system" as const, project_id: f.state.project_id };
  const effect = value(refreshHumanActionFollowUps(state, actor, f.io));
  f.commit({ ok: true, value: effect });
  expect(f.state.human_actions[0]).toMatchObject({
    status: "open",
    blocked_work_items: [],
    follow_up_work_items: original.blocked_work_items,
    ready_when: { kind: "card_merged", card_id: f.card.id },
  });
  expect(
    value(refreshHumanActionFollowUps(f.state, actor, f.io)).events,
  ).toEqual([]);
  expect(refreshHumanActionFollowUps(state, human, f.io).ok).toBe(false);
  confirm(f);
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});
