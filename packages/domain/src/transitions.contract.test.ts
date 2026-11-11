import { expect, expectTypeOf, test } from "vitest";
import {
  beginReviewRound,
  DEFAULT_MAX_REVIEW_ROUNDS,
  type ProduceStatus,
  type Result,
  transition,
} from "./index.js";

// Expected edges come from development-plan §4.4, not from iterating implementation tables.
test.each([
  ["produce", "todo", "dependencies_met", "ready"],
  ["verify", "in_progress", "review_passed", "passed"],
  ["verify", "passed", "withdraw_pass", "ready"],
  ["delivery", "submitted", "accept", "accepted"],
  ["decision", "open", "provisionally_resolve", "provisional"],
  ["human_action", "open", "complete", "done"],
  ["run", "dispatched", "acknowledge", "acked"],
  ["assignment", "suspended", "resume", "active"],
  ["runtime", "running", "run_finished", "idle"],
  ["runtime", "unknown", "session_replaced", "idle"],
  ["runtime", "lost", "session_replaced", "idle"],
  ["card", "backlog", "set_todo", "todo"],
] as const)("%s permits %s + %s -> %s", (machine, from, event, to) => {
  expect(transition(machine, from, event)).toEqual({ ok: true, value: to });
});

test.each([
  ["produce", "todo", "verifiers_passed"],
  ["verify", "todo", "review_passed"],
  ["delivery", "superseded", "accept"],
  ["decision", "revoked", "resolve"],
  ["human_action", "done", "complete"],
  ["run", "completed", "start"],
  ["assignment", "released", "resume"],
  ["runtime", "released", "provision"],
  ["card", "todo", "completion_review_passed"],
  ["card", "done", "cancel"],
  ["card", "cancelled", "cancel"],
] as const)("invariant 11: %s rejects %s + %s", (machine, from, event) => {
  expect(transition(machine, from, event)).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
});

test.each([
  "backlog",
  "todo",
  "in_progress",
  "review",
  "awaiting_merge",
] as const)("P2a-5: unfinished card %s can still be cancelled", (status) => {
  expect(transition("card", status, "cancel")).toEqual({
    ok: true,
    value: "cancelled",
  });
});

test("produce delivery, rejection, rework and blocking preserve the lifecycle", () => {
  expectTypeOf(transition("produce", "todo", "dependencies_met")).toEqualTypeOf<
    Result<ProduceStatus>
  >();
  let state: ProduceStatus = "ready";
  for (const [event, expected] of [
    ["run_started", "in_progress"],
    ["block", "blocked"],
    ["resume", "in_progress"],
    ["request_decision", "waiting_decision"],
    ["decision_resolved", "in_progress"],
    ["delivery_submitted", "delivered"],
    ["review_rejected", "changes_requested"],
    ["run_started", "in_progress"],
    ["delivery_submitted", "delivered"],
    ["verifiers_passed", "accepted"],
    ["cancel", "cancelled"],
  ] as const) {
    const result: Result<ProduceStatus> = transition("produce", state, event);
    expect(result).toEqual({ ok: true, value: expected });
    if (!result.ok) throw new Error(result.error.message);
    state = result.value;
  }
});

test("invariant 14: redelivery resets both failed and previously passed verification", () => {
  for (const status of ["failed", "passed"] as const)
    expect(transition("verify", status, "target_redelivered")).toEqual({
      ok: true,
      value: "ready",
    });
  for (const status of ["submitted", "accepted", "rejected"] as const)
    expect(transition("delivery", status, "supersede")).toEqual({
      ok: true,
      value: "superseded",
    });
});

test.each(["delivered", "accepted"] as const)(
  "invariant 14: a new delivery from produce:%s requires verification again",
  (from) => {
    expect(transition("produce", from, "delivery_submitted")).toEqual({
      ok: true,
      value: "delivered",
    });
  },
);

test("invariant 14: redelivery invalidates the version currently under review", () => {
  expect(transition("verify", "in_progress", "target_redelivered")).toEqual({
    ok: true,
    value: "ready",
  });
  expect(transition("verify", "cancelled", "target_redelivered")).toMatchObject(
    {
      ok: false,
      error: { code: "illegal_transition" },
    },
  );
});

test.each([
  ["runtime", "unknown", "idle"],
  ["run", "unknown", "running"],
] as const)(
  "invariant 8: %s reconnects from %s to %s without completing work",
  (machine, from, to) => {
    expect(transition(machine, from, "reconnected")).toEqual({
      ok: true,
      value: to,
    });
  },
);

test.each([
  ["runtime", "lost"],
  ["runtime", "released"],
  ["run", "completed"],
  ["run", "failed"],
  ["run", "cancelled"],
] as const)("invariant 11: reconnect cannot reopen %s:%s", (machine, from) => {
  expect(transition(machine, from, "reconnected")).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
});

test.each([
  "todo",
  "ready",
  "in_progress",
  "failed",
  "blocked",
  "waiting_decision",
] as const)("verify:%s can be cancelled with its card", (from) => {
  expect(transition("verify", from, "cancel")).toEqual({
    ok: true,
    value: "cancelled",
  });
});

test.each(["passed", "cancelled"] as const)(
  "invariant 11: terminal verify:%s cannot be cancelled",
  (from) => {
    expect(transition("verify", from, "cancel")).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
  },
);

test("decisions can resolve provisionally, be revoked, or be superseded as specified", () => {
  expect(transition("decision", "provisional", "resolve")).toEqual({
    ok: true,
    value: "resolved",
  });
  for (const status of ["provisional", "resolved"] as const)
    expect(transition("decision", status, "revoke")).toEqual({
      ok: true,
      value: "revoked",
    });
  expect(transition("decision", "resolved", "supersede")).toEqual({
    ok: true,
    value: "superseded",
  });
  expect(transition("decision", "open", "withdraw")).toEqual({
    ok: true,
    value: "withdrawn",
  });
});

test("invariant 8: losing runtime contact does not complete or fail business work", () => {
  expect(transition("runtime", "running", "connection_lost")).toEqual({
    ok: true,
    value: "unknown",
  });
  expect(transition("runtime", "unknown", "declared_lost")).toEqual({
    ok: true,
    value: "lost",
  });
  expect(transition("run", "running", "connection_lost")).toEqual({
    ok: true,
    value: "unknown",
  });
  expect(transition("run", "unknown", "complete")).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
});

test("invariant 13: a completion review precedes the merge gate", () => {
  expect(transition("card", "in_progress", "completion_submitted")).toEqual({
    ok: true,
    value: "review",
  });
  expect(transition("card", "review", "completion_review_passed")).toEqual({
    ok: true,
    value: "awaiting_merge",
  });
  expect(transition("card", "review", "completion_review_rejected")).toEqual({
    ok: true,
    value: "in_progress",
  });
  expect(transition("card", "review", "verifiers_passed")).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
});

test("review rounds allow the limit, stop before the next round, and honor an explicit limit", () => {
  expect(DEFAULT_MAX_REVIEW_ROUNDS).toBe(3);
  expect(beginReviewRound("ready", 3)).toEqual({
    ok: true,
    value: "in_progress",
  });
  expect(beginReviewRound("ready", 4)).toEqual({
    ok: true,
    value: "waiting_decision",
  });
  expect(beginReviewRound("ready", 4, 5)).toEqual({
    ok: true,
    value: "in_progress",
  });
  expect(beginReviewRound("passed", 4)).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
  for (const invalid of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    expect(beginReviewRound("ready", invalid)).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
    expect(beginReviewRound("ready", 1, invalid)).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
  }
});

test.each(["in_progress", "failed"] as const)(
  "invariants 10, 11: verify:%s reaches the review limit and waits for a decision",
  (from) => {
    expect(transition("verify", from, "review_limit_exceeded")).toEqual({
      ok: true,
      value: "waiting_decision",
    });
  },
);

test.each(["ready", "in_progress", "failed", "passed"] as const)(
  "invariant 14: verify:%s waits for a target after withdrawal",
  (from) => {
    expect(transition("verify", from, "target_withdrawn")).toEqual({
      ok: true,
      value: "todo",
    });
  },
);

test.each(["blocked", "waiting_decision", "cancelled"] as const)(
  "invariants 11, 14: target withdrawal cannot bypass verify:%s",
  (from) => {
    expect(transition("verify", from, "target_withdrawn")).toMatchObject({
      ok: false,
      error: { code: "illegal_transition" },
    });
  },
);

test.each([
  "todo",
  "ready",
  "in_progress",
  "failed",
  "blocked",
  "waiting_decision",
  "cancelled",
] as const)("only passed verification can withdraw, not %s", (from) => {
  expect(transition("verify", from, "withdraw_pass")).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
});

test("transition lookup rejects inherited object properties", () => {
  expect(transition("produce", "__proto__" as ProduceStatus, "cancel").ok).toBe(
    false,
  );
  expect(transition("produce", "todo", "toString").ok).toBe(false);
});
