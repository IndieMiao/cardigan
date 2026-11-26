import { expect, test } from "vitest";
import type { Decision, HumanAction } from "../index.js";
import {
  mergePlan,
  recordDecision,
  requestHumanAction,
  setHumanActionMergeBlocking,
  triageHumanAction,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human, id } from "./test-fixtures.js";

async function setup() {
  const f = mergeFixture();
  await f.accept();
  expect(f.state.cards[0]?.status).toBe("awaiting_merge");
  const { work_item_id: _work, ...base } = f.pm;
  const ops = {
    ...base,
    id: id("assignment", 900),
    scope: "standing" as const,
    standing_mode: "ops" as const,
  };
  f.commit({
    ok: true,
    value: {
      data: ops,
      changes: [{ collection: "assignments", entity: ops }],
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
  const hold = f.commit(
    requestHumanAction(
      f.state,
      human,
      {
        card_id: f.card.id,
        instructions: "在 Google 后台完成账号配置",
        why_human: "只有所有者有账号",
        executor: "owner",
        expected_return: "配置完成",
        blocked_work_items: [],
        blocks_merge: true,
        prerequisite: "external_account",
      },
      f.io,
    ),
  );
  const mergeQ = () =>
    f.state.decisions.find(
      (q) => q.trigger === "merge_confirmation" && q.status === "open",
    ) as Decision;
  return { f, ops: f.actor(ops), hold, mergeQ };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** A decision on the card the human already answered (e.g. SEN-Q-246). */
function seedHumanDecision(
  { f, mergeQ }: Setup,
  overrides: Partial<Decision> = {},
): Decision {
  const { trigger: _trigger, resolution: _r, ...plain } = mergeQ();
  const q: Decision = {
    ...plain,
    id: id("decision", 77),
    key: id("decision", 77),
    question: "Google 待办是否继续挡合并？",
    options: [
      { key: "unblock", description: "改为不挡合并", impact: "合并后跟进" },
      { key: "keep", description: "继续挡合并", impact: "等待完成" },
    ],
    status: "resolved",
    resolution: {
      option: "unblock",
      rationale: "改为合并后跟进",
      at: "2026-01-01T00:00:00.000Z",
      resolved_by: "human",
      via: "needs_you",
      raw_quote: "Google 待办改为不挡合并",
      via_chain: ["human"],
    },
    ...overrides,
  } as Decision;
  f.commit({
    ok: true,
    value: {
      data: q,
      changes: [{ collection: "decisions", entity: q }],
      events: [],
      timeline: [],
      token_requests: [],
    },
  });
  return q;
}
function confirm(f: Setup["f"], q: Decision) {
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
const action = (f: Setup["f"], h: HumanAction) =>
  f.state.human_actions.find((a) => a.id === h.id) as HumanAction;

test("C-760: the owner turns a credential/account hold into a post-merge follow-up and back", async () => {
  const s = await setup();
  const { f, hold } = s;
  const lifted = f.commit(
    setHumanActionMergeBlocking(
      f.state,
      human,
      {
        human_action_id: hold.id,
        blocks_merge: false,
        reason: "账号配置可以合并后再做",
      },
      f.io,
    ),
  );
  expect(lifted).toMatchObject({
    status: "open",
    blocks_merge: false,
    blocked_work_items: [],
    follow_up_work_items: hold.blocked_work_items,
    ready_when: { kind: "card_merged", card_id: f.card.id },
    merge_blocking_changes: [
      {
        by: "human",
        at: expect.any(String),
        blocks_merge: false,
        previous_blocks_merge: true,
        previous_prerequisite: "external_account",
        reason: "账号配置可以合并后再做",
        via: "direct",
      },
    ],
  });
  expect(lifted.prerequisite).toBeUndefined();
  const event = f.state.events.findLast(
    (e) => e.type === "human_action_merge_blocking_changed",
  );
  expect(event?.actor.kind).toBe("human");
  expect(event?.payload).toMatchObject({
    human_action_id: hold.id,
    blocks_merge: false,
    previous_blocks_merge: true,
    previous_prerequisite: "external_account",
    decision_id: null,
  });
  expect(
    f.state.timeline.findLast((t) => t.human_action_id === hold.id)?.body,
  ).toContain("改为合并后跟进");
  confirm(f, s.mergeQ());
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);

  // Back to a hold: a prerequisite is required, and the hold is shown now.
  expect(
    setHumanActionMergeBlocking(
      f.state,
      human,
      { human_action_id: hold.id, blocks_merge: true, reason: "还是要先配" },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  const held = f.commit(
    setHumanActionMergeBlocking(
      f.state,
      human,
      {
        human_action_id: hold.id,
        blocks_merge: true,
        prerequisite: "credential",
        reason: "还是要先配",
      },
      f.io,
    ),
  );
  expect(held).toMatchObject({
    blocks_merge: true,
    prerequisite: "credential",
  });
  expect(held.ready_when).toBeUndefined();
  expect(held.merge_blocking_changes).toHaveLength(2);
  expect(mergePlan(f.state, f.card.id)).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining(hold.id) },
  });
});

test("C-760: an Agent without the human's decision cannot lift the hold", async () => {
  const s = await setup();
  const { f, hold, ops } = s;
  const lift = { human_action_id: hold.id, blocks_merge: false, reason: "x" };
  expect(setHumanActionMergeBlocking(f.state, ops, lift, f.io)).toMatchObject({
    ok: false,
    error: { code: "unauthorized" },
  });
  expect(
    setHumanActionMergeBlocking(f.state, f.actor(f.coder), lift, f.io),
  ).toMatchObject({ ok: false });
  // PM triage without basis keeps the old refusal.
  const rewrite = {
    human_action_id: hold.id,
    disposition: "human" as const,
    rationale: "所有者选了不挡合并",
    title: "Google 账号配置",
    summary: "账号配置",
    why_human: "只有所有者有账号",
    instructions: "合并后在后台配置",
    expected_outcome: "配置完成",
    expected_return: "配置完成",
    blocks_merge: false,
  };
  expect(triageHumanAction(f.state, ops, rewrite, f.io)).toMatchObject({
    ok: false,
    error: { code: "unauthorized" },
  });
  // A decision PM resolved, or one on another card, is not a basis.
  for (const q of [
    seedHumanDecision(s, {
      resolution: {
        option: "unblock",
        rationale: "PM 决定",
        at: "2026-01-01T00:00:00.000Z",
        resolved_by: `assignment:${f.pm.id}`,
        via: "delegated",
        raw_quote: "PM 决定",
        via_chain: [],
      },
    }),
    seedHumanDecision(s, {
      card_id: id("card", 999),
      affected_cards: [id("card", 999)],
    }),
    seedHumanDecision(s, { status: "open", resolution: undefined as never }),
  ])
    expect(
      setHumanActionMergeBlocking(
        f.state,
        ops,
        { ...lift, decision_id: q.id },
        f.io,
      ),
    ).toMatchObject({ ok: false, error: { code: "unauthorized" } });
  expect(action(f, hold)).toMatchObject({
    blocks_merge: true,
    prerequisite: "external_account",
  });
});

test("C-760: PM Ops carries out the human's decision by citing it", async () => {
  const s = await setup();
  const { f, hold, ops } = s;
  const q = seedHumanDecision(s);
  const next = f.commit(
    setHumanActionMergeBlocking(
      f.state,
      ops,
      {
        human_action_id: hold.id,
        blocks_merge: false,
        reason: `按所有者在 ${q.id} 的选择改为合并后跟进`,
        decision_id: q.id,
      },
      f.io,
    ),
  );
  expect(next).toMatchObject({
    blocks_merge: false,
    merge_blocking_changes: [
      {
        by: expect.stringMatching(/^assignment:/),
        decision_id: q.id,
        raw_quote: "Google 待办改为不挡合并",
        via: "direct",
      },
    ],
  });
  expect(
    f.state.timeline.findLast((t) => t.human_action_id === hold.id)?.body,
  ).toContain(`依据拍板 ${q.id}`);
});

test("C-760: PM triage may lift the hold with the human's decision as basis", async () => {
  const s = await setup();
  const { f, hold, ops } = s;
  const q = seedHumanDecision(s);
  const next = f.commit(
    triageHumanAction(
      f.state,
      ops,
      {
        human_action_id: hold.id,
        disposition: "human",
        rationale: "所有者选了不挡合并",
        title: "Google 账号配置",
        summary: "账号配置",
        why_human: "只有所有者有账号",
        instructions: "合并后在后台配置",
        expected_outcome: "配置完成",
        expected_return: "配置完成",
        blocks_merge: false,
        basis_decision_id: q.id,
      },
      f.io,
    ),
  );
  expect(next).toMatchObject({
    blocks_merge: false,
    merge_blocking_changes: [
      { decision_id: q.id, via: "triage", previous_blocks_merge: true },
    ],
  });
  expect(
    f.state.events.findLast((e) => e.type === "human_action_requested")
      ?.payload,
  ).toMatchObject({ basis_decision_id: q.id, blocks_merge: false });
});

test("C-760: “仍要合并” refuses to pass an open hold unless the human ticks follow-up", async () => {
  const s = await setup();
  const { f, hold } = s;
  const q = s.mergeQ();
  const override = {
    decision_id: q.id,
    option: "merge",
    rationale: "Approved",
    raw_quote: "仍要合并",
    merge_override_reason: "账号配置合并后再做，先合并代码",
  };
  expect(recordDecision(f.state, human, override, f.io)).toMatchObject({
    ok: false,
    error: {
      code: "illegal_transition",
      message: expect.stringContaining(hold.id),
    },
  });
  expect(
    recordDecision(
      f.state,
      human,
      {
        decision_id: q.id,
        option: "merge",
        rationale: "Approved",
        raw_quote: "Merge",
        merge_override_follow_up: true,
      },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  const resolved = f.commit(
    recordDecision(
      f.state,
      human,
      { ...override, merge_override_follow_up: true },
      f.io,
    ),
  );
  expect(resolved.resolution?.merge_override?.blockers).toContain(
    `人工事项 ${hold.id}：尚未完成`,
  );
  expect(action(f, hold)).toMatchObject({
    status: "open",
    blocks_merge: false,
    follow_up_work_items: hold.blocked_work_items,
    merge_blocking_changes: [
      {
        by: "human",
        decision_id: q.id,
        raw_quote: "仍要合并",
        via: "merge_override",
      },
    ],
  });
  expect(mergePlan(f.state, f.card.id).ok).toBe(true);
});
