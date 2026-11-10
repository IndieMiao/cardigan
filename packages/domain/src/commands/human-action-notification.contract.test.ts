import { expect, test } from "vitest";
import type { Assignment, CommandState } from "../index.js";
import {
  completeHumanAction,
  listNeedsYou,
  requesterNotificationRecipient,
  requestHumanAction,
} from "../index.js";
import {
  actor,
  apply,
  fixture,
  human,
  id,
  ports,
  value,
} from "./test-fixtures.js";

function completed() {
  const io = ports();
  let state = fixture();
  const requested = value(
    requestHumanAction(
      state,
      actor(),
      {
        card_id: id("card", 1),
        instructions: "Provide sanitized copy",
        why_human: "Manual export",
        expected_return: "Location",
        blocked_work_items: [],
      },
      io,
    ),
  );
  state = apply(state, requested);
  const done = value(
    completeHumanAction(
      state,
      human,
      {
        human_action_id: requested.data.id,
        text: "Sanitized copy is ready",
      },
      io,
    ),
  );
  return { state: apply(state, done), action: done.data };
}

test.each(["active", "suspended", "released", "missing"] as const)(
  "invariant 3: completion resolves the original requester (%s), never another card owner",
  (status) => {
    const { state, action } = completed();
    const assignments = state.assignments.flatMap((a): Assignment[] =>
      a.id !== id("assignment", 1)
        ? [a]
        : status === "missing"
          ? []
          : [{ ...a, status }],
    );
    expect(
      requesterNotificationRecipient(action.requested_by, assignments),
    ).toEqual(
      status === "active"
        ? { kind: "assignment", assignment_id: id("assignment", 1) }
        : { kind: "needs_you" },
    );
    const withOps = assignments.map(
      (a): Assignment =>
        a.scope === "standing" ? { ...a, standing_mode: "ops" } : a,
    );
    expect(
      requesterNotificationRecipient(action.requested_by, withOps)?.kind,
    ).toBe(status === "active" ? "assignment" : "pm_ops");
  },
);

test("invariants 8 and 11: Needs You projects an unclaimed result without reopening the action or creating work", () => {
  const completedAction = completed();
  const state: CommandState = {
    ...completedAction.state,
    assignments: completedAction.state.assignments.map((a) =>
      a.id === id("assignment", 1) ? { ...a, status: "released" } : a,
    ),
  };
  const before = JSON.stringify(state);
  const result = value(listNeedsYou(state, human));
  expect(result.data.human_actions).toMatchObject([
    {
      id: completedAction.action.id,
      card_id: id("card", 1),
      status: "done",
      completion_notice: "Sanitized copy is ready",
    },
  ]);
  expect(result.changes).toEqual([]);
  expect(result.events).toEqual([]);
  expect(JSON.stringify(state)).toBe(before);
  for (const status of ["active", "suspended", "released"] as const) {
    const next = {
      ...state,
      assignments: state.assignments.map(
        (a): Assignment =>
          a.scope === "standing" ? { ...a, standing_mode: "ops", status } : a,
      ),
    };
    expect(value(listNeedsYou(next, human)).data.human_actions).toHaveLength(
      status === "active" ? 0 : 1,
    );
  }
  expect(
    value(listNeedsYou(completedAction.state, human)).data.human_actions,
  ).toEqual([]);
  expect(
    value(
      listNeedsYou(
        { ...state, cards: state.cards.map((c) => ({ ...c, status: "done" })) },
        human,
      ),
    ).data.human_actions,
  ).toEqual([]);
  expect(
    requesterNotificationRecipient("human", state.assignments),
  ).toBeUndefined();
});
