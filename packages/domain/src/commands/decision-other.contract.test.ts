import { beforeEach, expect, test } from "vitest";
import {
  DECISION_OTHER_LABEL,
  DECISION_OTHER_OPTION,
  type Decision,
  decisionOptionOf,
  extInteraction,
  humanDecisionOptions,
  type RequestDecisionParams,
  recordDecision,
  requestDecision,
  requestDeliveryRework,
  requestMerge,
  withdrawReview,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  ports,
  value,
} from "./test-fixtures.js";

let io = ports();
beforeEach(() => {
  io = ports();
});

const params: RequestDecisionParams = {
  card_id: id("card", 1),
  category: "spending",
  kind: "choose",
  question: "额度用完了，要不要提高支出上限？",
  context: "GitHub Actions 额度用完",
  options: [
    { key: "raise_limit", description: "提高上限", impact: "多花钱" },
    { key: "wait_reset", description: "等额度重置", impact: "暂停检查" },
  ],
  recommended: "raise_limit",
  affected_cards: [id("card", 1)],
  affected_work_items: [id("work_item", 1)],
  blocking: true,
  decider: "human",
  plain_summary: { changed: "额度用完", impact: "检查暂停", risk: "花钱" },
};
const other = (decision_id: Decision["id"], words: string) => ({
  decision_id,
  option: DECISION_OTHER_OPTION,
  rationale: words,
  raw_quote: words,
});

test("C-682: every decision shows the system 其他 after the raiser's options; raisers cannot claim or remove it", () => {
  const options = [
    { key: "merge", description: "合并", impact: "更新基线" },
    { key: DECISION_OTHER_OPTION, description: "伪造", impact: "伪造" },
    { key: "hold", description: "暂缓", impact: "等待" },
  ];
  expect(humanDecisionOptions(options).map((o) => o.key)).toEqual([
    "merge",
    "hold",
    DECISION_OTHER_OPTION,
  ]);
  expect(humanDecisionOptions([]).at(-1)?.description).toBe(
    DECISION_OTHER_LABEL,
  );
  const rejected = requestDecision(
    fixture(),
    actor(),
    {
      ...params,
      options: [
        ...params.options,
        { key: DECISION_OTHER_OPTION, description: "x", impact: "y" },
      ],
    },
    io,
  );
  expect(rejected.ok).toBe(false);
  if (!rejected.ok) expect(rejected.error.code).toBe("validation_failed");
});

test("C-682: an open agent decision closes with 其他; blank words are rejected and the raiser gets the words", () => {
  const initial = fixture();
  const requested = value(requestDecision(initial, actor(), params, io));
  const state = apply(initial, requested);
  // Opened before any change: nothing on the stored decision mentions 其他.
  expect(requested.data.options.map((o) => o.key)).not.toContain(
    DECISION_OTHER_OPTION,
  );
  for (const words of ["", "   "]) {
    const blank = recordDecision(
      state,
      human,
      other(requested.data.id, words),
      io,
    );
    expect(blank.ok).toBe(false);
    if (!blank.ok) {
      expect(blank.error.code).toBe("validation_failed");
      expect(blank.error.message).toContain("必须填写说明");
    }
  }
  const resolved = value(
    recordDecision(
      state,
      human,
      other(requested.data.id, "  把仓库转为公开  "),
      io,
    ),
  );
  const next = apply(state, resolved);
  expect(resolved.data).toMatchObject({
    status: "resolved",
    resolution: {
      option: DECISION_OTHER_OPTION,
      raw_quote: "把仓库转为公开",
      rationale: "把仓库转为公开",
      resolved_by: "human",
    },
  });
  const event = resolved.events.find((e) => e.type === "decision_resolved");
  expect(event?.payload).toMatchObject({
    option: DECISION_OTHER_OPTION,
    option_description: DECISION_OTHER_LABEL,
    other: true,
    other_text: "把仓库转为公开",
    raised_by: "assignment:A-1",
  });
  expect(
    resolved.timeline.find((t) => t.type === "decision_resolved")?.body,
  ).toBe(`${DECISION_OTHER_LABEL}：把仓库转为公开`);
  expect(decisionOptionOf(resolved.data, DECISION_OTHER_OPTION)?.key).toBe(
    DECISION_OTHER_OPTION,
  );
  // The raiser resumes to follow the owner's words.
  expect(next.work_items.find((w) => w.id === id("work_item", 1))?.status).toBe(
    "in_progress",
  );
  // A closed decision cannot be answered with 其他 again.
  expect(
    recordDecision(next, human, other(requested.data.id, "再改一次"), io).ok,
  ).toBe(false);
});

test("C-682: only the human may choose 其他, without suggestion, delegation or override", () => {
  const initial = fixture();
  const requested = value(
    requestDecision(initial, actor(), { ...params, category: "general" }, io),
  );
  const state = apply(initial, requested);
  const office = recordDecision(
    state,
    actor(4, "pm"),
    other(requested.data.id, "PM 代填"),
    io,
  );
  expect(office.ok).toBe(false);
  if (!office.ok) expect(office.error.code).toBe("forbidden_tool");
  const delegated = recordDecision(
    state,
    human,
    { ...other(requested.data.id, "以后都这样"), delegate_future: true },
    io,
  );
  expect(delegated.ok).toBe(false);
});

test("C-682: 其他 on a merge confirmation keeps the card unmerged, binds no merge, hold or return, and PM can ask again", async () => {
  const f = mergeFixture();
  await f.accept();
  const q = f.state.decisions.find(
    (q) => q.trigger === "merge_confirmation" && q.status === "open",
  );
  if (!q) throw new Error("Missing confirmation");
  const feishu = extInteraction(
    { ...f.state, decisions: [{ ...q, decider: "human" as const }] },
    {
      project_id: f.state.project_id,
      card_id: f.card.id,
      event_id: io.ids.nextEventId(),
      item_id: q.id,
      kind: "merge_confirmation",
      sensitive: false,
      handled: false,
      ready: true,
    },
  );
  expect(feishu.options.map((o) => o.key)).toContain(DECISION_OTHER_OPTION);
  expect(feishu.options.at(-1)?.key).toBe(DECISION_OTHER_OPTION);
  const result = recordDecision(
    f.state,
    human,
    other(q.id, "先别合并，等我和客户确认"),
    f.io,
  );
  const effect = value(result);
  f.commit(result);
  expect(f.state.cards.find((c) => c.id === f.card.id)?.status).toBe(
    "awaiting_merge",
  );
  expect(effect.data).toMatchObject({
    status: "resolved",
    resolution: { option: DECISION_OTHER_OPTION },
  });
  expect(effect.data.snooze).toBeUndefined();
  expect(effect.events.map((e) => e.type)).not.toContain(
    "merge_changes_requested",
  );
  expect(
    f.state.deliveries.filter((d) => d.status === "superseded"),
  ).toHaveLength(0);
  // No replacement confirmation is raised behind the owner's back.
  expect(
    f.state.decisions.filter(
      (d) =>
        d.trigger === "merge_confirmation" &&
        ["open", "snoozed", "provisional"].includes(d.status),
    ),
  ).toHaveLength(0);
  const again = value(
    requestMerge(f.state, human, { card_id: f.card.id }, f.io),
  );
  expect(again.data).toMatchObject({
    trigger: "merge_confirmation",
    status: "open",
  });
});

test("C-682: 其他 on a human rework request leaves the accepted delivery alone", async () => {
  const f = mergeFixture("confirm", 3);
  const product = await f.deliver();
  const review = f.review(product);
  f.commit(
    withdrawReview(
      f.state,
      f.actor(f.reviewer),
      { work_item_id: review.work_item_id, rationale: "New requirement" },
      f.io,
    ),
  );
  const requested = f.commit(
    requestDeliveryRework(
      f.state,
      human,
      {
        work_item_id: product.work_item_id,
        delivery_id: product.id,
        target_sha: product.subject.value,
        review_id: review.id,
        rationale: "Implement the newly approved requirement",
      },
      f.io,
    ),
  );
  const before = f.state.deliveries;
  const result = recordDecision(
    f.state,
    human,
    other(requested.id, "先保留"),
    f.io,
  );
  const effect = value(result);
  f.commit(result);
  expect(effect.data.resolution?.option).toBe(DECISION_OTHER_OPTION);
  expect(f.state.deliveries).toEqual(before);
  expect(effect.events.map((e) => e.type)).not.toContain(
    "delivery_rework_requested",
  );
});
