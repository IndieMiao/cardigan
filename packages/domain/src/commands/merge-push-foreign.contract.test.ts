import { expect, test } from "vitest";
import {
  type Actor,
  acceptMergePushHold,
  beginMergePush,
  type CommandState,
  checkMergePushRange,
  completeHumanAction,
  type Event,
  type MergePushAttempt,
  type MergePushCommit,
  type MergePushFailure,
  recordMergePushResult,
  recordMergeResult,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human } from "./test-fixtures.js";

// C-94: auto-push publishes only first-parent history the merge loop recorded,
// checked from the current central head down to an evidenced boundary.
const destination = { target: "f".repeat(64), branch: "main" };
const system: Actor = { kind: "system", project_id: human.project_id };
const sha = (c: string) => c.repeat(40);
const hex = (n: number) => n.toString(16).padStart(40, "0");
const A = sha("a"),
  B = sha("b"),
  C = sha("c"),
  D = sha("d"),
  E = sha("e"),
  F1 = sha("1"),
  F2 = sha("2"),
  P = sha("3"),
  X = sha("9");
const commit = (
  s: string,
  parent: string,
  who = "Cardigan",
): MergePushCommit => ({
  sha: s,
  parent,
  author: who,
  committer: who,
  subject: `commit ${s.slice(0, 4)}`,
});
/** Newest-first first-parent chain: link(D, C, B) = D→C→B→base. */
const link = (base: string, ...shas: string[]) =>
  shas.map((s, i) => commit(s, shas[i + 1] ?? base));
const required = <T>(v: T | undefined): T => {
  if (!v) throw new Error("Missing value");
  return v;
};

function harness() {
  let f: ReturnType<typeof mergeFixture> | undefined;
  let time = "2035-01-01T00:00:00.000Z";
  const state = (): CommandState => ({
    ...required(f).state,
    project_settings: {
      merge_push: [{ ...destination, base_branch: "main" }],
    },
  });
  const io = () => required(f).io;
  /** Merge one fresh card; the loop recorded (previous, merge]. */
  async function merge(previous_sha: string, merge_sha: string) {
    f = mergeFixture(
      "auto",
      3,
      f ? { state: f.state, ports: f.io } : undefined,
    );
    f.io.clock = { now: () => time };
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
  const raw = (
    attempt: MergePushAttempt,
    chain: MergePushCommit[],
    extra: { head?: string; truncated?: boolean } = {},
  ) =>
    checkMergePushRange(
      state(),
      system,
      {
        target: destination.target,
        attempt_id: attempt.attempt_id,
        head: extra.head ?? chain[0]?.sha ?? required(attempt.base_sha),
        chain,
        ...(extra.truncated ? { truncated: true } : {}),
      },
      io(),
    );
  const check = (...args: Parameters<typeof raw>) =>
    required(f).commit(raw(...args));
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
  const failed = (
    attempt: MergePushAttempt,
    reason: MergePushFailure = "auth",
  ) =>
    required(f).commit(
      recordMergePushResult(
        state(),
        system,
        {
          target: destination.target,
          attempt_id: attempt.attempt_id,
          status: "failed",
          reason,
          exit_code: 128,
        },
        io(),
      ),
    );
  const accept = (actor: Actor = human, text = "确认可以发布") =>
    acceptMergePushHold(
      state(),
      actor,
      { human_action_id: required(openAction()).id, text },
      io(),
    );
  const close = (text = "已回退中心 main") =>
    required(f).commit(
      completeHumanAction(
        state(),
        human,
        { human_action_id: required(openAction()).id, text },
        io(),
      ),
    );
  const openAction = () =>
    required(f).state.human_actions.find((a) => a.status === "open");
  const events = (type: string) =>
    required(f).state.events.filter((e) => e.type === type);
  const held = () =>
    events("merge_push_held").at(-1)?.payload as Record<string, unknown>;
  return {
    merge,
    begin,
    raw,
    check,
    pushed,
    failed,
    at: (value: string) => {
      time = value;
    },
    accept,
    close,
    openAction,
    events,
    held,
    state,
    io,
    get f() {
      return required(f);
    },
  };
}

/** First push to a new target: the human confirms the boundary once; B is then published. */
async function started() {
  const h = harness();
  await h.merge(A, B);
  const first = required(h.begin("first"));
  expect(first).toMatchObject({ base_sha: A, base_trusted: false });
  expect(h.check(first, link(A, B)).status).toBe("held");
  expect(h.held()).toMatchObject({ reasons: ["boundary"], acceptable: true });
  h.f.commit(h.accept());
  const retry = required(h.begin("first-retry"));
  expect(retry).toMatchObject({ base_sha: A, base_trusted: true });
  expect(h.check(retry, link(A, B))).toEqual({ status: "clear" });
  h.pushed(retry);
  return h;
}

test("after a trusted push, normal merges (including multi-delivery segments) pass silently", async () => {
  const h = await started();
  await h.merge(B, C);
  const attempt = required(h.begin("second"));
  expect(attempt).toMatchObject({ sha: C, base_sha: B, base_trusted: true });
  const before = h.f.state.events.length;
  // X is the loop's intermediate merge for the first delivery of C's plan.
  expect(h.check(attempt, link(B, C, X))).toEqual({ status: "clear" });
  expect(h.f.state.events).toHaveLength(before);
  h.pushed(attempt);
  expect(h.events("merge_pushed")).toHaveLength(2);
  expect(h.events("merge_push_held")).toHaveLength(1);
});

test("first push never trusts the pre-push baseline: a foreign merge below the first queued merge is held", async () => {
  // P→A recorded earlier; F is an unrecorded foreign merge; M=C built on F.
  const h = harness();
  await h.merge(P, A);
  await h.merge(F1, C);
  const attempt = required(h.begin("first"));
  // The candidate boundary is only the first queued merge's previous_sha.
  expect(attempt).toMatchObject({ base_sha: P, base_trusted: false });
  expect(h.check(attempt, link(P, C, F1, A)).status).toBe("held");
  expect(h.held()).toMatchObject({
    reasons: ["boundary", "foreign"],
    base_sha: P,
    foreign: [{ sha: F1 }],
  });
  expect(required(h.openAction()).instructions).toContain("第一次自动推送");
});

test("a foreign commit anywhere up to the current head holds the target and is listed by SHA, not name", async () => {
  const h = await started();
  await h.merge(F2, C);
  const attempt = required(h.begin("second"));
  // F2's committer is the loop identity; it is still foreign.
  expect(
    h.check(attempt, [
      commit(C, F2),
      commit(F2, F1, "Cardigan"),
      commit(F1, B, "UI Audit"),
    ]).status,
  ).toBe("held");
  expect(h.held()).toMatchObject({
    reasons: ["foreign"],
    acceptable: true,
    foreign_count: 2,
    foreign: [{ sha: F2 }, { sha: F1, author: "UI Audit" }],
  });
  const action = required(h.openAction());
  expect(action.instructions).toContain(F1.slice(0, 12));
  expect(action.instructions).toContain("UI Audit");
  expect(action.instructions).toContain(
    `cardigan merge push-accept ${action.id}`,
  );
  // Replays are idempotent and the attempt can no longer record a push.
  expect(h.check(attempt, link(B, C)).status).toBe("held");
  expect(
    h.f.state.human_actions.filter((a) => a.status === "open"),
  ).toHaveLength(1);
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
  await h.merge(C, D);
  expect(h.begin("paused")).toBeUndefined();
});

test("a foreign commit above the queued SHA is caught from the current head", async () => {
  const h = await started();
  await h.merge(B, C);
  const attempt = required(h.begin("second"));
  // Central main moved on to F1 after C was queued; pushing C alone would not
  // carry F1, but the project still pauses.
  expect(h.check(attempt, link(B, F1, C)).status).toBe("held");
  expect(h.held()).toMatchObject({ head: F1, foreign: [{ sha: F1 }] });
});

test("a reset main that no longer contains the queued merge is held as stale and cannot be accepted", async () => {
  const h = await started();
  await h.merge(B, C);
  const attempt = required(h.begin("second"));
  expect(h.check(attempt, link(B, D)).status).toBe("held");
  expect(h.held()).toMatchObject({ acceptable: false });
  expect(h.held().reasons).toEqual(
    expect.arrayContaining(["stale", "foreign"]),
  );
  expect(required(h.openAction()).instructions).not.toContain("push-accept");
  expect(h.accept().ok).toBe(false);
  h.close();
  expect(h.begin("dropped")).toBeUndefined();
  expect(h.events("merge_push_hold_resolved").at(-1)?.payload).toMatchObject({
    mode: "reverted",
    accepted: [],
  });
});

test("a recorded segment whose previous_sha does not close on the chain trusts nothing it would cover", async () => {
  const h = await started();
  // Recorded merge C claims previous X; the real chain is C→F1→B.
  await h.merge(X, C);
  const attempt = required(h.begin("second"));
  expect(h.check(attempt, link(B, C, F1)).status).toBe("held");
  expect(h.held()).toMatchObject({
    foreign: [{ sha: F1 }],
    reasons: ["foreign"],
  });
});

test("a long clean backlog of recorded merges is checked in full and pushes", async () => {
  const h = await started();
  const shas = Array.from({ length: 1_500 }, (_, i) => hex(i + 1));
  let previous = B;
  for (const s of shas.slice(0, 3)) {
    await h.merge(previous, s);
    previous = s;
  }
  // Record the remaining merges cheaply on the same state.
  const recorded = shas.slice(3).map(
    (s, i): Event => ({
      ...required(h.f.state.events.find((e) => e.type === "card_merged")),
      id: `synthetic-${i}` as never,
      seq: 1_000_000 + i,
      payload: {
        result: {
          kind: "merged",
          merge_sha: s,
          previous_sha: required(shas[i + 2]),
        },
      },
    }),
  );
  const attempt = required(h.begin("backlog"));
  const state = h.state();
  const result = checkMergePushRange(
    { ...state, events: [...state.events, ...recorded] },
    system,
    {
      target: destination.target,
      attempt_id: attempt.attempt_id,
      head: required(shas.at(-1)),
      chain: link(B, ...[...shas].reverse()),
    },
    h.io(),
  );
  expect(result.ok && result.value.data).toEqual({ status: "clear" });
});

test("a truncated or broken range holds and cannot be accepted", async () => {
  const h = await started();
  await h.merge(B, C);
  const attempt = required(h.begin("second"));
  expect(h.check(attempt, link(B, C), { truncated: true }).status).toBe("held");
  expect(h.held()).toMatchObject({ reasons: ["too_long"], acceptable: false });
  expect(h.accept().ok).toBe(false);
  const g = await started();
  await g.merge(X, C);
  const next = required(g.begin("rewritten"));
  expect(g.check(next, [commit(C, X), commit(X, D)]).status).toBe("held");
  expect(g.held().reasons).toContain("broken");
  expect(g.accept().ok).toBe(false);
});

test("only the human accepts; accept trusts exactly the listed SHAs and resumes one coalesced push", async () => {
  const h = await started();
  await h.merge(F2, C);
  const attempt = required(h.begin("second"));
  h.check(attempt, [commit(C, F2), commit(F2, F1), commit(F1, B)]);
  await h.merge(C, D);
  for (const actor of [system, h.f.actor(h.f.coder)])
    expect(h.accept(actor).ok).toBe(false);
  h.f.commit(h.accept(human, "确认是用户要的界面修复"));
  expect(h.events("merge_push_hold_resolved").at(-1)?.payload).toMatchObject({
    mode: "accept",
    accepted: [F2, F1],
  });
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
  // Acceptance is per SHA: a new foreign commit is held again.
  await h.merge(sha("7"), E);
  const next = required(h.begin("next"));
  expect(h.check(next, [commit(E, sha("7")), commit(sha("7"), D)]).status).toBe(
    "held",
  );
});

test.each([
  { coalesced: false, reason: "auth" },
  { coalesced: true, reason: "auth" },
  { coalesced: true, reason: "network" },
  { coalesced: false, reason: "rejected" },
] as const)(
  "accepting repeated holds keeps the auth retry budget (coalesced=$coalesced, first=$reason)",
  async ({ coalesced, reason }) => {
    const h = await started();
    await h.merge(B, C);
    if (coalesced) await h.merge(C, D);
    const first = required(h.begin("auth-first"));
    h.failed(first, reason);
    if (reason === "rejected") h.close();
    else expect(h.openAction()).toBeUndefined();
    h.at("2035-01-01T00:01:00.000Z");
    let attempt = required(h.begin("auth-retry"));
    const pending = coalesced ? [D, C] : [C];
    for (const [index, foreign] of [[F1], [F2, F1]].entries()) {
      expect(h.check(attempt, link(B, ...foreign, ...pending)).status).toBe(
        "held",
      );
      h.f.commit(h.accept());
      attempt = required(h.begin(`after-hold-${index}`));
      expect(attempt.auth_retry_used).toBe(true);
      expect(attempt.queue_ids).toHaveLength(coalesced ? 2 : 1);
      expect(h.begin(`restart-${index}`)).toEqual(attempt);
    }
    expect(h.check(attempt, link(B, F2, F1, ...pending))).toEqual({
      status: "clear",
    });
    const result = h.failed(attempt);
    expect(result.next_retry_at).toBeUndefined();
    expect(h.openAction()?.status).toBe("open");
    h.at("2035-01-01T01:00:00.000Z");
    expect(h.begin("third-auto-push")).toBeUndefined();
    h.close();
    h.pushed(required(h.begin("after-auth-repair")));
    await h.merge(coalesced ? D : C, E);
    const fresh = required(h.begin("fresh-range"));
    expect(fresh.auth_retry_used).toBeUndefined();
    expect(h.failed(fresh).next_retry_at).toBeDefined();
  },
);

test("accepting a hold before any failure retains the first auth retry, while reverting drops the old budget", async () => {
  const h = await started();
  await h.merge(B, C);
  const first = required(h.begin("first-hold"));
  h.check(first, link(B, F1, C));
  h.f.commit(h.accept());
  const accepted = required(h.begin("accepted-before-failure"));
  expect(accepted.auth_retry_used).toBeUndefined();
  expect(h.failed(accepted).next_retry_at).toBeDefined();
  h.at("2035-01-01T00:01:00.000Z");
  const retry = required(h.begin("auth-retry"));
  h.check(retry, link(B, F2, F1, C));
  // Reverting drops C; the later recorded merge has its own budget.
  await h.merge(B, D);
  h.close();
  const fresh = required(h.begin("after-revert"));
  expect(fresh.sha).toBe(D);
  expect(fresh.auth_retry_used).toBeUndefined();
  expect(h.failed(fresh).next_retry_at).toBeDefined();
});

test("closing without accept is a revert: held merges drop, nothing is trusted, the next push re-checks the head", async () => {
  const h = await started();
  await h.merge(F2, C);
  const attempt = required(h.begin("second"));
  h.check(attempt, [commit(C, F2), commit(F2, F1), commit(F1, B)]);
  // A merge queued after the hold survives the revert and is checked afresh.
  await h.merge(C, D);
  h.close("只关掉事项，没回退");
  const next = required(h.begin("next"));
  expect(next.sha).toBe(D);
  expect(next.queue_ids).toHaveLength(1);
  expect(h.events("merge_push_hold_resolved").at(-1)?.payload).toMatchObject({
    mode: "reverted",
    accepted: [],
    dropped_queue_ids: [h.events("merge_push_queued")[1]?.id],
  });
  // The foreign commits are still on main, so the push is held again.
  expect(
    h.check(next, [commit(D, C), commit(C, F2), commit(F2, F1), commit(F1, B)])
      .status,
  ).toBe("held");
  // After a real revert the loop merges on the restored baseline and pushes.
  h.close();
  expect(h.begin("dropped")).toBeUndefined();
  await h.merge(B, E);
  const clean = required(h.begin("clean"));
  expect(h.check(clean, link(B, E))).toEqual({ status: "clear" });
});

test("the range check is system-only and must start at the reported head", async () => {
  const h = await started();
  await h.merge(B, C);
  const attempt = required(h.begin("second"));
  expect(
    checkMergePushRange(
      h.state(),
      human,
      {
        target: destination.target,
        attempt_id: attempt.attempt_id,
        head: C,
        chain: link(B, C),
      },
      h.io(),
    ).ok,
  ).toBe(false);
  expect(h.raw(attempt, link(B, C), { head: D }).ok).toBe(false);
  expect(h.raw(attempt, [{ ...commit(C, B), sha: "not-a-sha" }]).ok).toBe(
    false,
  );
  expect(
    checkMergePushRange(
      h.state(),
      system,
      {
        target: destination.target,
        attempt_id: "other",
        head: C,
        chain: link(B, C),
      },
      h.io(),
    ).ok,
  ).toBe(false);
});
