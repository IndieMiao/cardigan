import { expect, test } from "vitest";
import {
  type Actor,
  hasPassedMergeCheck,
  latestMergeCheck,
  type MergeCheckView,
  mergePlan,
  prepareMergePlan,
  projectSnapshot,
  recheckMerge,
  recordDecision,
  recordMergeCheck,
  recordMergeResult,
  requestDecision,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human, value } from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const tree = "c".repeat(40),
  candidate = "b".repeat(40);
async function fixture(policy: "auto" | "confirm" = "auto") {
  const f = mergeFixture(policy),
    { completion, product } = await f.accept();
  const state = () => ({
    ...f.state,
    project_settings: { merge_gate_enabled: true },
  });
  const identity = {
    card_id: f.card.id,
    completion_id: completion.id,
    attempt_id: "attempt-1",
    candidate_sha: candidate,
    tree_sha: tree,
  };
  const record = (
    status: MergeCheckView["status"],
    attempt_id = "attempt-1",
    tree_sha = tree,
  ) =>
    f.commit(
      recordMergeCheck(
        state(),
        system,
        status === "queued" || status === "running"
          ? { ...identity, attempt_id, tree_sha, status }
          : {
              ...identity,
              attempt_id,
              tree_sha,
              status,
              summary: status,
              log_ref: `${attempt_id}.log`,
              checks: [
                {
                  name: "test",
                  status,
                  exit_code: status === "passed" ? 0 : 1,
                  duration_ms: 12,
                },
              ],
            },
        f.io,
      ),
    );
  const merged = {
    card_id: f.card.id,
    completion_id: completion.id,
    result: {
      kind: "merged" as const,
      merge_sha: candidate,
      previous_sha: "a".repeat(40),
      tree_sha: tree,
    },
  };
  return { f, state, identity, record, merged, completion, product };
}

test("a decision opened during checking blocks publication but does not lose the failure result", async () => {
  const { f, state, record, identity } = await fixture();
  record("queued");
  record("running");
  f.commit(
    requestDecision(
      f.state,
      human,
      {
        card_id: f.card.id,
        kind: "choose",
        category: "general",
        question: "Release now?",
        context: "New concern",
        options: [{ key: "yes", description: "Proceed", impact: "Release" }],
        recommended: "yes",
        affected_cards: [f.card.id],
        affected_work_items: [],
        blocking: true,
        decider: "human",
      },
      f.io,
    ),
  );
  expect(prepareMergePlan(state(), f.card.id).ok).toBe(false);
  record("failed");
  expect(
    latestMergeCheck(f.state.events, f.card.id, identity.completion_id)?.status,
  ).toBe("failed");
});

test("invariant 21: only system records ordered checks; preparation precedes human confirmation", async () => {
  const { f, state, identity, record, merged } = await fixture("confirm");
  expect(prepareMergePlan(state(), f.card.id).ok).toBe(true);
  expect(mergePlan(state(), f.card.id).ok).toBe(false);
  expect(
    recordMergeCheck(f.state, system, { ...identity, status: "queued" }, f.io)
      .ok,
  ).toBe(false);
  for (const actor of [
    human,
    f.actor(f.coder),
    f.actor(f.pm),
    { ...system, project_id: "other" } as Actor,
  ])
    expect(
      recordMergeCheck(state(), actor, { ...identity, status: "queued" }, f.io)
        .ok,
    ).toBe(false);
  expect(
    recordMergeCheck(state(), system, { ...identity, status: "running" }, f.io)
      .ok,
  ).toBe(false);
  record("queued");
  expect(
    value(
      recordMergeCheck(
        state(),
        system,
        { ...identity, status: "queued" },
        f.io,
      ),
    ).events,
  ).toEqual([]);
  record("running");
  record("passed");
  expect(f.state.events.slice(-3).map((e) => e.type)).toEqual([
    "merge_check_queued",
    "merge_check_started",
    "merge_check_finished",
  ]);
  expect(f.state.cards[0]?.status).toBe("awaiting_merge");
  expect(recordMergeResult(state(), system, merged, f.io).ok).toBe(false);
  const decision = f.state.decisions.at(-1);
  if (!decision) throw new Error("Missing confirmation");
  f.commit(
    recordDecision(
      f.state,
      human,
      {
        decision_id: decision.id,
        option: "merge",
        rationale: "Ready",
        raw_quote: "Merge",
      },
      f.io,
    ),
  );
  f.commit(recordMergeResult(state(), system, merged, f.io));
  expect(f.state.cards[0]?.status).toBe("done");
});

test("invariant 21: an enabled gate rejects untested or different trees and reuses a passed tree for a new candidate", async () => {
  const { f, state, record, merged, completion } = await fixture();
  expect(recordMergeResult(state(), system, merged, f.io)).toMatchObject({
    ok: false,
    error: { code: "invariant_violation" },
  });
  record("queued");
  record("running");
  record("passed");
  expect(
    recordMergeResult(
      state(),
      system,
      { ...merged, result: { ...merged.result, tree_sha: "d".repeat(40) } },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    hasPassedMergeCheck(f.state.events, f.card.id, completion.id, tree),
  ).toBe(true);
  expect(
    value(projectSnapshot(state(), human)).data.cards[0]?.merge_check,
  ).toMatchObject({
    status: "passed",
    tree_sha: tree,
    log_ref: "attempt-1.log",
  });
  const nextCandidate = {
    ...merged,
    result: { ...merged.result, merge_sha: "d".repeat(40) },
  };
  f.commit(recordMergeResult(state(), system, nextCandidate, f.io));
  expect(f.state.cards[0]?.status).toBe("done");
  expect(
    value(recordMergeResult(state(), system, nextCandidate, f.io)).events,
  ).toEqual([]);
});

test("invariant 21: no gate preserves legacy merges; a verified noop is explicitly marked and cannot advance the baseline", async () => {
  const { f, state, merged } = await fixture();
  expect(recordMergeResult(f.state, system, merged, f.io).ok).toBe(true);
  expect(
    recordMergeResult(
      state(),
      system,
      { ...merged, result: { ...merged.result, noop: true } },
      f.io,
    ).ok,
  ).toBe(false);
  const noop = {
    ...merged,
    result: {
      kind: "merged" as const,
      merge_sha: candidate,
      previous_sha: candidate,
      noop: true,
    },
  };
  f.commit(recordMergeResult(state(), system, noop, f.io));
  expect(f.state.cards[0]?.status).toBe("done");
  expect(f.state.events.at(-1)?.payload).toMatchObject({
    result: { noop: true, merge_sha: candidate, previous_sha: candidate },
  });
  expect(f.state.events.some((e) => e.type === "merge_check_finished")).toBe(
    false,
  );
});

test.each(["failed", "timed_out"] as const)(
  "invariant 21: %s needs a human recheck; no automatic retry or result rewrite",
  async (status) => {
    const { f, state, record, identity } = await fixture();
    record("queued");
    record("running");
    record(status);
    expect(
      recordMergeCheck(
        state(),
        system,
        { ...identity, attempt_id: "attempt-2", status: "queued" },
        f.io,
      ).ok,
    ).toBe(false);
    for (const actor of [system, f.actor(f.pm), f.actor(f.coder)])
      expect(
        recheckMerge(state(), actor, { card_id: f.card.id }, f.io).ok,
      ).toBe(false);
    expect(
      recordMergeCheck(
        state(),
        system,
        {
          ...identity,
          status: "passed",
          checks: [{ name: "test", status: "passed", exit_code: 0 }],
          summary: "replace failed",
          log_ref: "attempt-1.log",
        },
        f.io,
      ).ok,
    ).toBe(false);
    f.commit(recheckMerge(state(), human, { card_id: f.card.id }, f.io));
    expect(
      latestMergeCheck(f.state.events, f.card.id, identity.completion_id),
    ).toMatchObject({ status: "queued", recheck_requested: true });
    expect(recheckMerge(state(), human, { card_id: f.card.id }, f.io).ok).toBe(
      false,
    );
    record("queued", "attempt-2");
    record("running", "attempt-2");
    record("passed", "attempt-2");
    expect(recheckMerge(state(), human, { card_id: f.card.id }, f.io).ok).toBe(
      false,
    );
  },
);

test("invariant 21: interrupted attempts automatically requeue with a fresh id and invalid proof cannot pass", async () => {
  const { f, state, record, identity } = await fixture();
  record("queued");
  record("interrupted");
  record("queued", "attempt-2");
  record("running", "attempt-2");
  for (const patch of [
    { candidate_sha: "HEAD" },
    { tree_sha: "a".repeat(40) },
    { checks: [] },
    { log_ref: "../secret.log" },
    { checks: [{ name: "test", status: "failed" as const, exit_code: 1 }] },
  ])
    expect(
      recordMergeCheck(
        state(),
        system,
        {
          ...identity,
          attempt_id: "attempt-2",
          status: "passed",
          checks: [{ name: "test", status: "passed", exit_code: 0 }],
          summary: "Done",
          log_ref: "attempt-2.log",
          ...patch,
        },
        f.io,
      ).ok,
    ).toBe(false);
  record("passed", "attempt-2");
});

test("invariant 21: a new tree is eligible after failure but an old completion cannot authorize its successor", async () => {
  const { f, state, record, identity, product } = await fixture();
  record("queued");
  record("running");
  record("failed");
  record("queued", "attempt-2", "e".repeat(40));
  record("running", "attempt-2", "e".repeat(40));
  record("passed", "attempt-2", "e".repeat(40));
  f.commit(
    recordMergeResult(
      state(),
      system,
      {
        card_id: f.card.id,
        completion_id: identity.completion_id,
        result: {
          kind: "conflicted",
          delivery_id: product.id,
          files: ["file"],
        },
      },
      f.io,
    ),
  );
  expect(recheckMerge(state(), human, { card_id: f.card.id }, f.io).ok).toBe(
    false,
  );
  const next = await f.deliver("code", "d".repeat(40));
  f.review(next);
  const completion = await f.deliver("card_completion", next.subject.value);
  f.review(completion);
  expect(
    recordMergeCheck(
      state(),
      system,
      { ...identity, attempt_id: "late", status: "queued" },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "stale_target" } });
  expect(
    recordMergeResult(
      state(),
      system,
      {
        card_id: f.card.id,
        completion_id: completion.id,
        result: {
          kind: "merged",
          merge_sha: candidate,
          previous_sha: "a".repeat(40),
          tree_sha: "e".repeat(40),
        },
      },
      f.io,
    ).ok,
  ).toBe(false);
});
