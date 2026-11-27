import { type CommandState, requestDecision } from "@cardigan/domain";
import { expect, test } from "vitest";
import {
  actor,
  apply,
  fixture,
  id,
  ports,
  value,
} from "../../../../packages/domain/src/commands/test-fixtures.js";
import { cardDetail, needsYou } from "./read.js";

function decisionState(extra: {
  readonly attachments_omitted?: number;
  readonly acceptance_criteria_snapshot?: readonly string[];
}): CommandState {
  const state = fixture();
  const effect = value(
    requestDecision(
      state,
      actor(4, "pm"),
      {
        card_id: id("card", 1),
        kind: "choose",
        category: "general",
        question: "请你确认：按图做",
        context: "背景",
        options: [{ key: "go", description: "按图做", impact: "开始" }],
        recommended: "go",
        decider: "human",
        plain_summary: { changed: "改动", impact: "影响", risk: "无" },
        affected_cards: [],
        affected_work_items: [],
        blocking: false,
      },
      ports(),
    ),
  );
  const next = apply(state, effect);
  // The domain sets these on system completion reviews (C-809); the read
  // model only passes them through.
  return {
    ...next,
    decisions: next.decisions.map((q) => ({ ...q, ...extra })),
  };
}

test("C-810: Needs You and card details carry the attachment overflow and the criteria snapshot", () => {
  const state = decisionState({
    attachments_omitted: 2,
    acceptance_criteria_snapshot: ["第一条", "第二条"],
  });
  const expected = {
    attachments_omitted: 2,
    acceptance_criteria_snapshot: ["第一条", "第二条"],
  };
  expect(needsYou(state, "2026-01-02").decisions[0]).toMatchObject(expected);
  expect(cardDetail(state, id("card", 1))?.decisions[0]).toMatchObject(
    expected,
  );
});

test("C-810: older decisions without them read as before", () => {
  const view = needsYou(decisionState({}), "2026-01-02").decisions[0];
  expect(view).toBeDefined();
  expect(view).not.toHaveProperty("attachments_omitted");
  expect(view).not.toHaveProperty("acceptance_criteria_snapshot");
});
