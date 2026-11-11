import { expect, test } from "vitest";
import {
  type Actor,
  acceptMergePushHold,
  beginMergePush,
  type CommandState,
  checkMergePushRange,
  completeHumanAction,
  type MergePushAttempt,
  type MergePushCommit,
  recordMergePushResult,
  recordMergeResult,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human } from "./test-fixtures.js";

// C-94: auto-push publishes only first-parent history the merge loop recorded.
const destination = { target: "f".repeat(64), branch: "main" };
const system: Actor = { kind: "system", project_id: human.project_id };
const sha = (c: string) => c.repeat(40);
const A = sha("a"),
  B = sha("b"),
  C = sha("c"),
  D = sha("d"),
  E = sha("e"),
  F1 = sha("1"),
  F2 = sha("2"),
  X = sha("9");
const commit = (
  s: string,
  parent: string,
  who = "Cardigan Merge",
): MergePushCommit => ({
  sha: s,
  parent,
  author: who,
  committer: who,
  subject: `commit ${s.slice(0, 4)}`,
});
const required = <T>(v: T | undefined): T => {
  if (!v) throw new Error("Missing value");
  return v;
};

function harness() {
  let f: ReturnType<typeof mergeFixture> | undefined;
  const state = (): CommandState => ({
    ...required(f).state,
    project_settings: { merge_push: destination },
  });
  const io = () => required(f).io;
  /** Merge one fresh card; the loop recorded (previous, merge]. */
  async function merge(previous_sha: string, merge_sha: string) {
    f = mergeFixture(
      "auto",
      3,
      f ? { state: f.state, ports: f.io } : undefined,
    );
    f.io.clock = { now: () => "2035-01-01T00:00:00.000Z" };
    const { completion } = await f.accept();
    f.commit(
      recordMergeResult(
        state(),
        system,
        {
          card_id: f.card.id,
          completion_id: completion.id,
          result: { kind: "merged", merge_sha, previous_sha },
        },
        f.io,
      ),
    );
  }
  const begin = (attempt_id: string) =>
    required(f).commit(
      beginMergePush(state(), system, { ...destination, attempt_id }, io()),
    );
  const check = (attempt: MergePushAttempt, chain: MergePushCommit[]) =>
    required(f).commit(
      checkMergePushRange(
        state(),
        system,
        {
          target: destination.target,
          attempt_id: attempt.attempt_id,
          chain,
        },
        io(),
      ),
    );
  const pushed = (attempt: MergePushAttempt) =>
    required(f).commit(
      recordMergePushResult(
        state(),
        system,
        {
          target: destination.target,
          attempt_id: attempt.attempt_id,
          status: "pushed",
        },
        io(),
      ),
    );
  const events = (type: string) =>
    required(f).state.events.filter((e) => e.type === type);
  return {
    merge,
    begin,
    check,
    pushed,
    events,
    state,
    io,
    get f() {
      return required(f);
    },
  };
}

/** A pushed, then F1/F2 written straight into central main, then the loop merged C. */
async function heldScenario() {
  const h = harness();
  await h.merge(A, B);
  const first = required(h.begin("first"));
  expect(first.base_sha).toBe(A);
  expect(h.check(first, [commit(B, A)])).toEqual({ status: "clear" });
  h.pushed(first);
  await h.merge(F2, C);
  const attempt = required(h.begin("second"));
  expect(attempt).toMatchObject({ sha: C, base_sha: B });
  // F2's committer mimics the loop identity; it is still foreign.
  const held = h.check(attempt, [
    commit(C, F2),
    commit(F2, F1, "Cardigan Merge"),
    commit(F1, B, "UI Audit"),
  ]);
  return { h, attempt, held };
}

test("normal merges pass the range check silently, including multi-delivery segments", async () => {
  const h = harness();
  await h.merge(A, B);
  const attempt = required(h.begin("first"));
  // X is the loop's intermediate merge for the first delivery of B's plan.
  const before = h.f.state.events.length;
  expect(h.check(attempt, [commit(B, X), commit(X, A)])).toEqual({
    status: "clear",
  });
  expect(h.f.state.events).toHaveLength(before);
  h.pushed(attempt);
  expect(h.events("merge_pushed")).toHaveLength(1);
  expect(h.f.state.human_actions).toHaveLength(0);
});

test("a foreign first-parent commit holds the push, lists it in plain language and pauses the target", async () => {
  const { h, attempt, held } = await heldScenario();
  expect(held.status).toBe("held");
  const [event] = h.events("merge_push_held");
  expect(event?.card_id).toBeUndefined();
  expect(event?.payload).toMatchObject({
    target: destination.target,
    sha: C,
    base_sha: B,
    broken: false,
    foreign: [
      { sha: F2, committer: "Cardigan Merge" },
      { sha: F1, author: "UI Audit" },
    ],
  });
  const action = required(h.f.state.human_actions.at(-1));
  expect(action).toMatchObject({ status: "open", requested_by: "system" });
  expect(action.instructions).toContain(F1.slice(0, 12));
  expect(action.instructions).toContain("UI Audit");
  expect(action.instructions).toContain(
    `cardigan merge push-accept ${action.id}`,
  );
  expect(h.events("human_action_requested")).toHaveLength(1);
  // Replaying the check is idempotent; the hold is the attempt's outcome.
  expect(h.check(attempt, [commit(C, F2)]).status).toBe("held");
  expect(h.f.state.human_actions).toHaveLength(1);
  expect(
    recordMergePushResult(
      h.state(),
      system,
      {
        target: destination.target,
        attempt_id: attempt.attempt_id,
        status: "pushed",
      },
      h.io(),
    ).ok,
  ).toBe(false);
  // Later merges keep merging but do not push while the action is open.
  await h.merge(C, D);
  expect(h.begin("paused")).toBeUndefined();
  expect(h.events("merge_push_started")).toHaveLength(2);
});

test("only the human can accept; accepting trusts exactly the listed SHAs and resumes one coalesced push", async () => {
  const { h } = await heldScenario();
  await h.merge(C, D);
  const action = required(h.f.state.human_actions.at(-1));
  for (const actor of [system, h.f.actor(h.f.coder)])
    expect(
      acceptMergePushHold(
        h.state(),
        actor,
        { human_action_id: action.id, text: "接受" },
        h.io(),
      ).ok,
    ).toBe(false);
  h.f.commit(
    acceptMergePushHold(
      h.state(),
      human,
      { human_action_id: action.id, text: "确认是用户要的界面修复" },
      h.io(),
    ),
  );
  expect(h.f.state.human_actions.at(-1)?.status).toBe("done");
  expect(h.events("merge_push_hold_resolved").at(-1)?.payload).toMatchObject({
    mode: "accept",
    accepted: [F2, F1],
    dropped_queue_ids: [],
  });
  expect(
    acceptMergePushHold(
      h.state(),
      human,
      { human_action_id: action.id, text: "再次" },
      h.io(),
    ).ok,
  ).toBe(false);
  const retry = required(h.begin("after-accept"));
  expect(retry).toMatchObject({ sha: D, base_sha: B, failure_count: 0 });
  expect(retry.queue_ids).toHaveLength(2);
  expect(
    h.check(retry, [
      commit(D, C),
      commit(C, F2),
      commit(F2, F1),
      commit(F1, B),
    ]),
  ).toEqual({ status: "clear" });
  h.pushed(retry);
  expect(h.begin("empty")).toBeUndefined();
  // Acceptance is by SHA: a new foreign commit is held again.
  await h.merge(E.replace(/e/gu, "7"), E);
  const next = required(h.begin("next"));
  expect(
    h.check(next, [commit(E, sha("7")), commit(sha("7"), D, "UI Audit")])
      .status,
  ).toBe("held");
});

test("closing the action without accept means reverted: held merges are dropped, nothing becomes trusted", async () => {
  const { h } = await heldScenario();
  const action = required(h.f.state.human_actions.at(-1));
  h.f.commit(
    completeHumanAction(
      h.state(),
      human,
      { human_action_id: action.id, text: "已把中心 main 回退到 B" },
      h.io(),
    ),
  );
  expect(h.begin("after-revert")).toBeUndefined();
  const resolved = h.events("merge_push_hold_resolved");
  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.payload).toMatchObject({
    mode: "reverted",
    accepted: [],
    dropped_queue_ids: [h.events("merge_push_queued")[1]?.id],
  });
  expect(h.begin("still-empty")).toBeUndefined();
  expect(h.events("merge_push_hold_resolved")).toHaveLength(1);
  // The loop merges again on the restored baseline; that range is clean.
  await h.merge(B, D);
  const next = required(h.begin("next"));
  expect(next).toMatchObject({ sha: D, base_sha: B });
  expect(next.queue_ids).toHaveLength(1);
  expect(h.check(next, [commit(D, B)])).toEqual({ status: "clear" });
  h.pushed(next);
  // Had the foreign commits stayed, they are not trusted after a revert.
  await h.merge(F2, E);
  const again = required(h.begin("again"));
  expect(
    h.check(again, [commit(E, F2), commit(F2, F1), commit(F1, D)]).status,
  ).toBe("held");
});

test("merges queued after the hold survive a revert and are checked afresh", async () => {
  const { h } = await heldScenario();
  await h.merge(C, D);
  const action = required(h.f.state.human_actions.at(-1));
  h.f.commit(
    completeHumanAction(
      h.state(),
      human,
      { human_action_id: action.id, text: "没回退" },
      h.io(),
    ),
  );
  const next = required(h.begin("next"));
  expect(next.sha).toBe(D);
  expect(next.queue_ids).toHaveLength(1);
  expect(
    h.check(next, [commit(D, C), commit(C, F2), commit(F2, F1), commit(F1, B)])
      .status,
  ).toBe("held");
});

test("a range that does not reach the last push is held as broken and cannot be accepted", async () => {
  const h = harness();
  await h.merge(A, B);
  const first = required(h.begin("first"));
  h.check(first, [commit(B, A)]);
  h.pushed(first);
  await h.merge(X, C);
  const attempt = required(h.begin("rewritten"));
  expect(h.check(attempt, [commit(C, X), commit(X, D)]).status).toBe("held");
  expect(h.events("merge_push_held")[0]?.payload).toMatchObject({
    broken: true,
  });
  const action = required(h.f.state.human_actions.at(-1));
  expect(action.instructions).not.toContain("push-accept");
  expect(
    acceptMergePushHold(
      h.state(),
      human,
      { human_action_id: action.id, text: "接受" },
      h.io(),
    ).ok,
  ).toBe(false);
  // Malformed host input and checks for another attempt are rejected.
  expect(
    checkMergePushRange(
      h.state(),
      system,
      { target: destination.target, attempt_id: "other", chain: [] },
      h.io(),
    ).ok,
  ).toBe(false);
});

test("the range check is system-only and must start at the pushed SHA", async () => {
  const h = harness();
  await h.merge(A, B);
  const attempt = required(h.begin("first"));
  const p = {
    target: destination.target,
    attempt_id: attempt.attempt_id,
    chain: [commit(B, A)],
  };
  expect(checkMergePushRange(h.state(), human, p, h.io()).ok).toBe(false);
  expect(
    checkMergePushRange(
      h.state(),
      system,
      { ...p, chain: [commit(C, B), commit(B, A)] },
      h.io(),
    ).ok,
  ).toBe(false);
  expect(
    checkMergePushRange(
      h.state(),
      system,
      { ...p, chain: [{ ...commit(B, A), sha: "not-a-sha" }] },
      h.io(),
    ).ok,
  ).toBe(false);
});
