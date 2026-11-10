import { expect, test } from "vitest";
import {
  type Assignment,
  queueRun,
  recordDecision,
  requestDecision,
  resolveDelegatedDecision,
  standingTools,
} from "../index.js";
import { CommandDraft } from "./core.js";
import {
  actor,
  apply,
  assignment,
  fixture,
  human,
  id,
  ports,
  role,
  value,
} from "./test-fixtures.js";

function office(external?: boolean): Assignment {
  const { work_item_id: _work, ...base } = assignment(9, "pm");
  return {
    ...base,
    scope: "standing",
    standing_mode: "office",
    ...(external === undefined ? {} : { external }),
  };
}

test("external identity is restricted to standing Office and immutable, including legacy rows", () => {
  for (const a of [office(), office(false), office(true)]) {
    const state = { ...fixture(), assignments: [a] };
    const draft = new CommandDraft(state, human, "get_updates", ports());
    expect(() =>
      draft.put("assignments", { ...a, eta: "2030-01-01T00:00:00.000Z" }),
    ).not.toThrow();
    expect(() =>
      draft.put("assignments", { ...a, external: !a.external }),
    ).toThrow();
  }
  for (const a of [
    { ...assignment(), external: true },
    { ...office(true), standing_mode: "ops" },
    { ...office(true), standing_mode: undefined },
    { ...office(), external: "true" },
  ]) {
    const draft = new CommandDraft(fixture(), human, "get_updates", ports());
    expect(() => draft.put("assignments", a as Assignment)).toThrow();
  }
});

test("external identities cannot queue a managed Run or replace a session", () => {
  const a = office(true);
  const state = { ...fixture(), assignments: [a] };
  expect(
    queueRun(
      state,
      human,
      { assignment_id: a.id, model: "fixture", agent_cli_version: "1" },
      ports(),
    ),
  ).toMatchObject({
    ok: false,
    error: { message: expect.stringContaining("没有可以启动的终端") },
  });
  expect(state.assignments[0]).toEqual(a);
});

test.each(["spending", "account", "permission", "data_deletion"] as const)(
  "external Office cannot transcribe or delegate %s decisions",
  (category) => {
    for (const external of [false, true]) {
      const a = office(external);
      const state = {
        ...fixture(),
        assignments: [...fixture().assignments, a],
      };
      const p = ports();
      const effect = value(
        requestDecision(
          state,
          human,
          {
            card_id: id("card", 1),
            kind: "choose",
            category,
            question: "是否执行",
            context: "需要人确认",
            options: [{ key: "yes", description: "执行", impact: "改变项目" }],
            recommended: "yes",
            decider: "human",
            blocking: false,
            affected_cards: [id("card", 1)],
            affected_work_items: [],
          },
          p,
        ),
      );
      const next = apply(state, effect);
      const identity = {
        ...actor(9, "pm"),
        allowed_tools: standingTools(role("pm").allowed_tools, "office"),
      };
      const answer = {
        decision_id: effect.data.id,
        option: "yes",
        rationale: "转录确认",
        raw_quote: "同意",
      };
      expect(recordDecision(next, identity, answer, p).ok).toBe(false);
      expect(resolveDelegatedDecision(next, identity, answer, p).ok).toBe(
        false,
      );
      // Even a forged tool list cannot turn an external identity into a human.
      expect(resolveDelegatedDecision(next, actor(9, "pm"), answer, p).ok).toBe(
        false,
      );
      expect(recordDecision(next, human, answer, p).ok).toBe(true);
    }
  },
);
