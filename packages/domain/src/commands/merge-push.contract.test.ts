import { expect, test } from "vitest";
import {
  type Actor,
  beginMergePush,
  type CommandState,
  completeHumanAction,
  type MergePushAttempt,
  type MergePushFailure,
  recordMergePushResult,
  recordMergeResult,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human, value } from "./test-fixtures.js";

const destination = { target: "f".repeat(64), branch: "main" };
const system: Actor = { kind: "system", project_id: human.project_id };
const now = "2035-01-01T00:00:00.000Z";
async function fixture(
  prior?: ReturnType<typeof mergeFixture>,
  sha = "b".repeat(40),
) {
  const f = mergeFixture(
    "auto",
    3,
    prior ? { state: prior.state, ports: prior.io } : undefined,
  );
  f.io.clock = { now: () => now };
  const { completion } = await f.accept();
  const state = (): CommandState => ({
    ...f.state,
    project_settings: { merge_push: destination },
  });
  const merge = {
    card_id: f.card.id,
    completion_id: completion.id,
    result: {
      kind: "merged" as const,
      merge_sha: sha,
      previous_sha: "a".repeat(40),
    },
  };
  const finishMerge = () =>
    f.commit(recordMergeResult(state(), system, merge, f.io));
  const begin = (attempt_id: string) =>
    f.commit(
      beginMergePush(state(), system, { ...destination, attempt_id }, f.io),
    );
  const finish = (attempt: MergePushAttempt, reason?: MergePushFailure) =>
    f.commit(
      recordMergePushResult(
        state(),
        system,
        {
          target: destination.target,
          attempt_id: attempt.attempt_id,
          ...(reason
            ? { status: "failed" as const, reason }
            : { status: "pushed" as const }),
        },
        f.io,
      ),
    );
  const at = (minutes: number) => {
    f.io.clock = {
      now: () => new Date(Date.parse(now) + minutes * 60_000).toISOString(),
    };
  };
  return { f, state, merge, finishMerge, begin, finish, at };
}
const required = <T>(v: T | undefined): T => {
  if (!v) throw new Error("Missing value");
  return v;
};

test("only a persisted successful merge queues a push, in the same effect; replay and disabled config do not duplicate it", async () => {
  const h = await fixture();
  expect(h.begin("before-merge")).toBeUndefined();
  const failed = value(
    recordMergeResult(
      h.state(),
      system,
      { ...h.merge, result: { kind: "failed", reason: "fixture" } },
      h.f.io,
    ),
  );
  expect(failed.events.some((e) => e.type === "merge_push_queued")).toBe(false);
  const effect = value(recordMergeResult(h.state(), system, h.merge, h.f.io));
  expect(effect.events.map((e) => e.type)).toEqual([
    "card_merged",
    "merge_push_queued",
  ]);
  expect(effect.events[1]).toMatchObject({
    actor: system,
    payload: {
      sha: h.merge.result.merge_sha,
      merge_event_id: effect.events[0]?.id,
      target: destination.target,
      branch: "main",
    },
  });
  expect(effect.events[1]?.card_id).toBeUndefined();
  h.finishMerge();
  h.finishMerge();
  expect(
    h.f.state.events.filter((e) => e.type === "merge_push_queued"),
  ).toHaveLength(1);
  const noConfig = await fixture();
  noConfig.f.commit(
    recordMergeResult(noConfig.f.state, system, noConfig.merge, noConfig.f.io),
  );
  expect(noConfig.begin("disabled")).toBeUndefined();
});

test("only system can start/result, a pending push survives restart, and result replay is immutable", async () => {
  const h = await fixture();
  h.finishMerge();
  for (const actor of [
    human,
    h.f.actor(h.f.coder),
    { ...system, project_id: "foreign" } as Actor,
  ])
    expect(
      beginMergePush(
        h.state(),
        actor,
        { ...destination, attempt_id: "bad" },
        h.f.io,
      ).ok,
    ).toBe(false);
  const started = required(h.begin("attempt-1")),
    cards = JSON.stringify(h.f.state.cards);
  expect(h.begin("restart-attempt")).toEqual(started);
  expect(
    h.f.state.events.filter((e) => e.type === "merge_push_started"),
  ).toHaveLength(1);
  expect(
    recordMergePushResult(
      h.state(),
      human,
      {
        target: destination.target,
        attempt_id: started.attempt_id,
        status: "pushed",
      },
      h.f.io,
    ).ok,
  ).toBe(false);
  expect(
    recordMergePushResult(
      h.state(),
      system,
      { target: destination.target, attempt_id: "unknown", status: "pushed" },
      h.f.io,
    ).ok,
  ).toBe(false);
  h.finish(started);
  h.finish(started);
  expect(
    h.f.state.events.filter((e) => e.type === "merge_pushed"),
  ).toHaveLength(1);
  expect(
    recordMergePushResult(
      h.state(),
      system,
      {
        target: destination.target,
        attempt_id: started.attempt_id,
        status: "failed",
        reason: "other",
      },
      h.f.io,
    ).ok,
  ).toBe(false);
  expect(h.begin("again")).toBeUndefined();
  expect(JSON.stringify(h.f.state.cards)).toBe(cards);
});

test.each(["rejected", "auth", "other"] as const)(
  "%s waits for a completed human action, then coalesces only once to the latest queued merge",
  async (reason) => {
    let h = await fixture();
    h.finishMerge();
    const first = required(h.begin("first"));
    h.finish(first, reason);
    const action = required(h.f.state.human_actions.at(-1));
    expect(action).toMatchObject({
      status: "open",
      requested_by: "system",
      blocked_work_items: [],
    });
    expect(h.begin("blocked")).toBeUndefined();
    const oldSha = first.sha;
    h = await fixture(h.f, "c".repeat(40));
    h.finishMerge();
    expect(h.f.state.cards.every((c) => c.status === "done")).toBe(true);
    expect(h.begin("new-merge-blocked")).toBeUndefined();
    h.f.commit(
      completeHumanAction(
        h.state(),
        human,
        { human_action_id: action.id, text: "已处理" },
        h.f.io,
      ),
    );
    const retry = required(h.begin("after-human"));
    expect(retry.queue_ids).toHaveLength(2);
    expect(retry.sha).not.toBe(oldSha);
    expect(retry.sha).toBe("c".repeat(40));
    h.finish(retry, reason);
    expect(h.begin("cannot-loop")).toBeUndefined();
    expect(
      h.f.state.human_actions.filter((a) => a.status === "open"),
    ).toHaveLength(1);
    const second = required(
      h.f.state.human_actions.find((a) => a.status === "open"),
    );
    h.f.commit(
      completeHumanAction(
        h.state(),
        human,
        { human_action_id: second.id, text: "再次修复" },
        h.f.io,
      ),
    );
    const success = required(h.begin("final"));
    h.finish(success);
    expect(h.begin("empty")).toBeUndefined();
  },
);

test("network failure waits 1/2/4 minutes, caps at 30, opens one action after two hours and recovers without changing cards", async () => {
  const h = await fixture();
  h.finishMerge();
  let time = 0;
  for (let count = 0; count < 9; count++) {
    h.at(time);
    const attempt = required(h.begin(`network-${count}`));
    const result = h.finish(attempt, "network"),
      delay = Math.min(2 ** count, 30);
    expect(result.next_retry_at).toBe(
      new Date(Date.parse(now) + (time + delay) * 60_000).toISOString(),
    );
    expect(h.begin(`too-soon-${count}`)).toBeUndefined();
    if (time <= 120) expect(h.f.state.human_actions).toHaveLength(0);
    else
      expect(
        h.f.state.human_actions.filter((a) => a.status === "open"),
      ).toHaveLength(1);
    time += delay;
  }
  expect(h.f.state.human_actions).toHaveLength(1);
  h.at(time);
  h.finish(required(h.begin("recovered")));
  expect(h.f.state.human_actions[0]?.status).toBe("cancelled");
  expect(h.f.state.cards[0]?.status).toBe("done");
});

test("ordinary retries never leap to a later merge, even after reconstructing the state", async () => {
  let h = await fixture();
  h.finishMerge();
  const first = required(h.begin("first"));
  h.finish(first, "network");
  h = await fixture(h.f, "c".repeat(40));
  h.finishMerge();
  h.at(1);
  const retry = required(h.begin("network-retry"));
  expect(retry.sha).toBe(first.sha);
  expect(retry.queue_ids).toEqual(first.queue_ids);
  h.finish(retry);
  const second = required(h.begin("second"));
  expect(second.sha).toBe("c".repeat(40));
  h.finish(second);
  expect(h.begin("done")).toBeUndefined();
});
