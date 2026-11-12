import { expect, test } from "vitest";
import {
  type Actor,
  autoConfirmMerge,
  createHostOpsAssignment,
  currentMergeConfirmations,
  HOST_OPS_ROLE_TOOLS,
  hasPassedMergeCheck,
  hasTimeoutAutoRerun,
  hasVerifiedMergeNoop,
  latestMergeCheck,
  listNeedsYou,
  type MergeCheckView,
  mergePlan,
  prepareMergePlan,
  projectSnapshot,
  recheckMerge,
  recordDecision,
  recordMergeCheck,
  recordMergePreparation,
  recordMergeResult,
  requestDecision,
  setProjectPreferences,
  TIMEOUT_AUTO_RERUN,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { apply, human, value } from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const tree = "c".repeat(40),
  candidate = "b".repeat(40);

test("C-115: only host-verified current noop becomes visible without authorizing a merge", async () => {
  const { f, state, identity } = await fixture("confirm");
  const p = {
    card_id: f.card.id,
    completion_id: identity.completion_id,
    base_sha: "a".repeat(40),
    noop: true,
  };
  const q = currentMergeConfirmations(state(), f.card.id)[0];
  if (!q) throw new Error("Missing confirmation");
  expect(
    value(listNeedsYou(state(), human)).data.waiting_merge_checks_count,
  ).toBe(1);
  for (const actor of [human, f.actor(f.coder)])
    expect(recordMergePreparation(state(), actor, p, f.io)).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
  expect(
    recordMergePreparation(
      state(),
      system,
      { ...p, completion_id: "D-999" as never },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    recordMergePreparation(state(), system, { ...p, base_sha: "invalid" }, f.io)
      .ok,
  ).toBe(false);
  f.commit(recordMergePreparation(state(), system, p, f.io));
  expect(
    value(recordMergePreparation(state(), system, p, f.io)).events,
  ).toEqual([]);
  const needs = value(listNeedsYou(state(), human)).data;
  expect(needs.decisions.map((q) => q.id)).toContain(q.id);
  expect(needs.waiting_merge_checks_count).toBe(0);
  expect(
    latestMergeCheck(state().events, f.card.id, p.completion_id),
  ).toBeUndefined();
  expect(
    hasPassedMergeCheck(state().events, f.card.id, p.completion_id, tree),
  ).toBe(false);
  expect(mergePlan(state(), f.card.id).ok).toBe(false);
  expect(
    hasVerifiedMergeNoop(state().events, f.card.id, "D-999" as never),
  ).toBe(false);
  // A new non-noop candidate invalidates the display exception immediately.
  f.commit(
    recordMergePreparation(
      state(),
      system,
      { ...p, noop: false, base_sha: "d".repeat(40) },
      f.io,
    ),
  );
  expect(
    value(listNeedsYou(state(), human)).data.decisions.map((q) => q.id),
  ).not.toContain(q.id);
});

test("C-115: detail actions track current completion and confirmed failure, not history", async () => {
  const { f, state, identity, record } = await fixture("confirm");
  const q = currentMergeConfirmations(state(), f.card.id)[0];
  if (!q) throw new Error("Missing confirmation");
  f.commit(
    recordDecision(
      state(),
      human,
      {
        decision_id: q.id,
        option: "merge",
        rationale: "合并",
        raw_quote: "合并",
      },
      f.io,
    ),
  );
  expect(currentMergeConfirmations(state(), f.card.id)).toEqual([]);
  record("queued");
  record("running");
  record("failed");
  expect(
    currentMergeConfirmations(state(), f.card.id).map((q) => q.id),
  ).toEqual([q.id]);
  f.commit(recheckMerge(state(), human, { card_id: f.card.id }, f.io));
  expect(currentMergeConfirmations(state(), f.card.id)).toEqual([]);
  const stale = {
    ...state(),
    deliveries: state().deliveries.map((d) =>
      d.id === identity.completion_id
        ? { ...d, status: "superseded" as const }
        : d,
    ),
  };
  expect(currentMergeConfirmations(stale, f.card.id)).toEqual([]);
});

test("C-85 grants only the exact active host_ops permission and preserves human rechecks", async () => {
  const { f, state, record } = await fixture();
  record("queued");
  record("running");
  record("failed");
  const base = {
    ...state(),
    roles: [
      ...state().roles,
      {
        role_id: "host_ops",
        role_version: 1,
        allowed_tools: HOST_OPS_ROLE_TOOLS,
        capabilities: [],
      },
    ],
  };
  const created = value(createHostOpsAssignment(base, human, {}, f.io));
  const current = apply(base, created);
  const actor: Actor = {
    kind: "assignment",
    project_id: base.project_id,
    assignment_id: created.data.assignment.id,
    role_id: "host_ops",
    role_version: 1,
    allowed_tools: HOST_OPS_ROLE_TOOLS,
    capabilities: [],
  };
  const granted = value(
    recheckMerge(current, actor, { card_id: f.card.id }, f.io),
  );
  expect(
    granted.events.find((e) => e.type === "host_ops_action_taken"),
  ).toMatchObject({
    actor,
    payload: { tool: "host_ops_recheck_merge", target_id: f.card.id },
  });
  for (const denied of [
    { ...actor, allowed_tools: ["host_ops_cancel_run"] },
    { ...actor, project_id: "other" },
    { ...actor, role_id: "pm" },
  ])
    expect(
      recheckMerge(current, denied as Actor, { card_id: f.card.id }, f.io).ok,
    ).toBe(false);
  expect(
    recheckMerge(
      {
        ...current,
        assignments: current.assignments.map((a) =>
          a.id === actor.assignment_id ? { ...a, status: "released" } : a,
        ),
      },
      actor,
      { card_id: f.card.id },
      f.io,
    ).ok,
  ).toBe(false);
  const effect = value(
    recheckMerge(current, human, { card_id: f.card.id }, f.io),
  );
  expect(effect.events.some((e) => e.type === "merge_check_requeued")).toBe(
    true,
  );
  expect(effect.events.some((e) => e.type === "host_ops_action_taken")).toBe(
    false,
  );
});

test("a queued attempt can fail before any command starts, but cannot claim executed checks", async () => {
  const { f, state, identity, record } = await fixture();
  record("queued");
  const failure = {
    ...identity,
    status: "failed" as const,
    checks: [],
    summary: "Candidate synchronization failed before execution",
    log_ref: "attempt-1.log",
  };
  expect(
    recordMergeCheck(
      state(),
      system,
      {
        ...failure,
        checks: [{ name: "test", status: "failed", exit_code: 1 }],
      },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    recordMergeCheck(state(), system, { ...failure, status: "passed" }, f.io)
      .ok,
  ).toBe(false);
  f.commit(recordMergeCheck(state(), system, failure, f.io));
  expect(
    latestMergeCheck(f.state.events, f.card.id, identity.completion_id)?.status,
  ).toBe("failed");
  expect(
    recordMergeCheck(
      state(),
      system,
      { ...identity, attempt_id: "auto-retry", status: "queued" },
      f.io,
    ).ok,
  ).toBe(false);
  f.commit(recheckMerge(state(), human, { card_id: f.card.id }, f.io));
  f.commit(
    recordMergeCheck(
      state(),
      system,
      { ...identity, attempt_id: "manual-retry", status: "queued" },
      f.io,
    ),
  );
});
// C-116: a failure made only of timeouts is requeued automatically, once per
// completion; anything else, or the second failure, follows the PM flow.
const finish = (
  identity: {
    card_id: never;
    completion_id: never;
    attempt_id: string;
    candidate_sha: string;
    tree_sha: string;
  },
  status: "failed" | "timed_out",
  steps: readonly ("passed" | "failed" | "timed_out" | "not_run")[],
  timeout_only?: boolean,
) => ({
  ...identity,
  status,
  summary: status,
  log_ref: `${identity.attempt_id}.log`,
  checks: steps.map((s, i) => ({
    name: `check-${i}`,
    status: s,
    exit_code: s === "passed" ? 0 : 1,
  })),
  ...(timeout_only === undefined ? {} : { timeout_only }),
});

test.each([
  {
    name: "a step timeout",
    status: "timed_out",
    steps: ["timed_out"],
    timeout_only: true,
  },
  {
    name: "a timed-out step after passed ones",
    status: "failed",
    steps: ["passed", "timed_out", "not_run"],
    timeout_only: true,
  },
  {
    name: "vitest test timeouts",
    status: "failed",
    steps: ["passed", "failed"],
    timeout_only: true,
  },
] as const)(
  "C-116: $name classified by the supervisor is requeued automatically once and recorded",
  async ({ status, steps, timeout_only }) => {
    const { f, state, record, identity } = await fixture();
    record("queued");
    record("running");
    const effect = value(
      recordMergeCheck(
        state(),
        system,
        finish(identity as never, status, steps, timeout_only),
        f.io,
      ),
    );
    expect(effect.events.map((e) => e.type)).toEqual([
      "merge_check_finished",
      "merge_check_requeued",
    ]);
    expect(effect.events[0]?.payload).toMatchObject({
      status,
      auto_rerun: true,
    });
    expect(effect.events[1]?.payload).toMatchObject({
      status: "queued",
      recheck_requested: true,
      via: TIMEOUT_AUTO_RERUN,
      failed_status: status,
      completion_id: identity.completion_id,
    });
    expect(effect.events[1]?.payload).not.toHaveProperty("timeout_only");
    expect(effect.timeline.map((t) => t.body)).toContain("因超时自动重跑");
    // The finished result itself is returned, unchanged.
    expect(effect.data).toMatchObject({ status, attempt_id: "attempt-1" });
    f.commit({ ok: true, value: effect });
    expect(
      hasTimeoutAutoRerun(state().events, f.card.id, identity.completion_id),
    ).toBe(true);
    expect(
      latestMergeCheck(state().events, f.card.id, identity.completion_id),
    ).toMatchObject({ status: "queued", recheck_requested: true });
    // Nobody needs to recheck; the host queues a fresh attempt for the tree.
    expect(recheckMerge(state(), human, { card_id: f.card.id }, f.io).ok).toBe(
      false,
    );
    record("queued", "attempt-2");
    record("running", "attempt-2");
    record("passed", "attempt-2");
    expect(
      hasPassedMergeCheck(
        state().events,
        f.card.id,
        identity.completion_id,
        tree,
      ),
    ).toBe(true);
  },
);

test.each([
  { name: "an assertion failure", status: "failed", steps: ["failed"] },
  {
    name: "a timeout mixed with an assertion failure",
    status: "timed_out",
    steps: ["failed", "timed_out"],
  },
  {
    name: "a failure the supervisor did not classify as timeout",
    status: "failed",
    steps: ["failed"],
    timeout_only: false,
  },
  // V-431: a step that failed an assertion and then hung until its step
  // timeout looks structurally like a clean timeout; only the supervisor's
  // classification may authorize the rerun.
  {
    name: "a step timeout the supervisor saw other failures in",
    status: "timed_out",
    steps: ["timed_out"],
    timeout_only: false,
  },
  {
    name: "an unclassified step timeout",
    status: "timed_out",
    steps: ["timed_out"],
  },
  {
    name: "an unclassified timed-out step after passed ones",
    status: "failed",
    steps: ["passed", "timed_out", "not_run"],
  },
] as const)(
  "C-116: $name is not requeued automatically",
  async ({ status, steps, ...rest }) => {
    const { f, state, record, identity } = await fixture();
    record("queued");
    record("running");
    const timeout_only = "timeout_only" in rest ? rest.timeout_only : undefined;
    const effect = value(
      recordMergeCheck(
        state(),
        system,
        finish(identity as never, status, steps, timeout_only),
        f.io,
      ),
    );
    expect(effect.events.map((e) => e.type)).toEqual(["merge_check_finished"]);
    expect(effect.events[0]?.payload).not.toHaveProperty("auto_rerun");
    f.commit({ ok: true, value: effect });
    expect(
      latestMergeCheck(state().events, f.card.id, identity.completion_id)
        ?.status,
    ).toBe(status);
    expect(
      hasTimeoutAutoRerun(state().events, f.card.id, identity.completion_id),
    ).toBe(false);
  },
);

test("C-116: timeout_only is only accepted on failed or timed-out results", async () => {
  const { f, state, record, identity } = await fixture();
  record("queued");
  record("running");
  for (const bad of [
    {
      ...identity,
      status: "passed" as const,
      summary: "ok",
      log_ref: "attempt-1.log",
      checks: [{ name: "test", status: "passed" as const, exit_code: 0 }],
      timeout_only: true,
    },
    {
      ...identity,
      status: "interrupted" as const,
      summary: "stop",
      log_ref: "attempt-1.log",
      checks: [],
      timeout_only: true,
    },
    finish(identity as never, "failed", ["passed"], true),
    {
      ...finish(identity as never, "failed", ["failed"]),
      timeout_only: "yes" as never,
    },
  ])
    expect(recordMergeCheck(state(), system, bad, f.io)).toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
    });
});

test("C-116: each completion is rerun automatically at most once; later timeouts stay failed", async () => {
  const { f, state, record, identity } = await fixture();
  record("queued");
  record("running");
  f.commit(
    recordMergeCheck(
      state(),
      system,
      finish(identity as never, "timed_out", ["timed_out"], true),
      f.io,
    ),
  );
  expect(
    latestMergeCheck(state().events, f.card.id, identity.completion_id)?.status,
  ).toBe("queued");
  record("queued", "attempt-2");
  record("running", "attempt-2");
  const second = value(
    recordMergeCheck(
      state(),
      system,
      finish(
        { ...identity, attempt_id: "attempt-2" } as never,
        "failed",
        ["failed"],
        true,
      ),
      f.io,
    ),
  );
  expect(second.events.map((e) => e.type)).toEqual(["merge_check_finished"]);
  expect(second.events[0]?.payload).not.toHaveProperty("auto_rerun");
  f.commit({ ok: true, value: second });
  expect(
    latestMergeCheck(state().events, f.card.id, identity.completion_id),
  ).toMatchObject({ status: "failed", timeout_only: true });
  // A human recheck is not the automatic rerun and does not carry the
  // previous classification; its timeout still is not retried again.
  f.commit(recheckMerge(state(), human, { card_id: f.card.id }, f.io));
  const requeued = state().events.at(-1);
  expect(requeued?.payload).not.toHaveProperty("via");
  expect(requeued?.payload).not.toHaveProperty("timeout_only");
  record("queued", "attempt-3");
  record("running", "attempt-3");
  f.commit(
    recordMergeCheck(
      state(),
      system,
      finish(
        { ...identity, attempt_id: "attempt-3" } as never,
        "timed_out",
        ["timed_out"],
        true,
      ),
      f.io,
    ),
  );
  expect(
    latestMergeCheck(state().events, f.card.id, identity.completion_id)?.status,
  ).toBe("timed_out");
  expect(
    state().events.filter(
      (e) =>
        e.type === "merge_check_requeued" &&
        (e.payload as { via?: string }).via === TIMEOUT_AUTO_RERUN,
    ),
  ).toHaveLength(1);
});

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
    status: Exclude<MergeCheckView["status"], "executor_unreachable">,
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

test("a timeout-delegated confirmation still requires a passed check before publication", async () => {
  const { f, state, record, merged } = await fixture("confirm");
  f.commit(
    setProjectPreferences(
      state(),
      human,
      { auto_merge_after_minutes: 1 },
      f.io,
    ),
  );
  const decision = f.state.decisions.find(
    (q) => q.trigger === "merge_confirmation",
  );
  if (!decision) throw new Error("Missing confirmation");
  f.io.clock = { now: () => "2099-01-01T00:00:00.000Z" };
  const delegated = f.commit(
    autoConfirmMerge(state(), system, { decision_id: decision.id }, f.io),
  );
  expect(delegated.resolution).toMatchObject({
    via: "delegated",
    option: "merge",
    resolved_by: "system",
  });
  expect(mergePlan(state(), f.card.id).ok).toBe(true);
  expect(recordMergeResult(state(), system, merged, f.io)).toMatchObject({
    ok: false,
    error: { code: "invariant_violation" },
  });
  record("queued");
  record("running");
  record("failed");
  expect(recordMergeResult(state(), system, merged, f.io).ok).toBe(false);
  f.commit(recheckMerge(state(), human, { card_id: f.card.id }, f.io));
  record("queued", "rechecked");
  record("running", "rechecked");
  record("passed", "rechecked");
  f.commit(recordMergeResult(state(), system, merged, f.io));
  expect(f.state.cards[0]?.status).toBe("done");
});

for (const approval of ["open", "human", "delegated"] as const) {
  test.each(["failed", "timed_out"] as const)(
    `a ${approval} confirmation can return a %s check through the existing rework lifecycle`,
    async (status) => {
      const { f, state, record, completion } = await fixture("confirm");
      const decision = f.state.decisions[0];
      if (!decision) throw new Error("Missing confirmation");
      if (approval === "human")
        f.commit(
          recordDecision(
            state(),
            human,
            {
              decision_id: decision.id,
              option: "merge",
              rationale: "Merge",
              raw_quote: "Merge",
            },
            f.io,
          ),
        );
      if (approval === "delegated") {
        f.commit(
          setProjectPreferences(
            state(),
            human,
            { auto_merge_after_minutes: 1 },
            f.io,
          ),
        );
        f.io.clock = { now: () => "2099-01-01T00:00:00.000Z" };
        f.commit(
          autoConfirmMerge(state(), system, { decision_id: decision.id }, f.io),
        );
      }
      const authorization = f.state.decisions[0]?.resolution;
      record("queued");
      record("running");
      record(status);
      const needs = value(listNeedsYou(state(), human)).data;
      expect(needs.decisions.map((q) => q.id)).not.toContain(decision.id);
      expect(needs.waiting_merge_checks_count).toBe(1);
      // C-115 only changes presentation; the human return below is still authorized.
      const params = {
        decision_id: decision.id,
        option: "request_changes",
        rationale: "修复合并检查失败",
        raw_quote: "请先修复这次失败再申请合并",
      };
      const effect = value(recordDecision(state(), human, params, f.io));
      f.commit({ ok: true, value: effect });
      expect(f.state.cards[0]?.status).toBe("in_progress");
      expect(
        f.state.work_items.find((w) => w.id === f.coder.work_item_id),
      ).toMatchObject({
        status: "changes_requested",
        assignment_id: f.coder.id,
      });
      expect(
        f.state.deliveries.find((d) => d.id === completion.id)?.status,
      ).toBe("superseded");
      expect(
        f.state.work_items.find((w) => w.id === f.pm.work_item_id)?.status,
      ).toBe("todo");
      if (approval !== "open")
        expect(f.state.decisions[0]).toMatchObject({
          status: "superseded",
          resolution: authorization,
        });
      expect(effect.events).toContainEqual(
        expect.objectContaining({
          type: "merge_changes_requested",
          payload: expect.objectContaining({
            decision_id: decision.id,
            completion_id: completion.id,
            work_item_id: f.coder.work_item_id,
            run_kind: "fix",
            reason: params.rationale,
            raw_quote: params.raw_quote,
          }),
        }),
      );
      expect(effect.timeline).toContainEqual(
        expect.objectContaining({ body: `退回修改：${params.rationale}` }),
      );
      expect(value(listNeedsYou(state(), human)).data.decisions).toEqual([]);
      expect(recordDecision(state(), human, params, f.io).ok).toBe(false);
      expect(mergePlan(state(), f.card.id).ok).toBe(false);
      const next = await f.deliver("code", "e".repeat(40));
      f.review(next);
      const request = await f.deliver("card_completion", next.subject.value);
      f.review(request);
      expect(f.state.decisions.at(-1)).toMatchObject({
        status: "open",
        target: { delivery_id: request.id },
      });
      expect(f.state.decisions.at(-1)?.id).not.toBe(decision.id);
      expect(
        latestMergeCheck(state().events, f.card.id, request.id),
      ).toBeUndefined();
      expect(recordDecision(state(), human, params, f.io).ok).toBe(false);
    },
  );
}

test.each([
  "missing",
  "queued",
  "running",
  "passed",
  "interrupted",
  "requeued",
] as const)(
  "a confirmed merge with a %s latest check cannot be returned or offered in Needs You",
  async (status) => {
    const { f, state, record } = await fixture("confirm");
    const decision = f.state.decisions[0];
    if (!decision) throw new Error("Missing confirmation");
    const params = {
      decision_id: decision.id,
      option: "request_changes",
      rationale: "Fix",
      raw_quote: "Fix",
    };
    f.commit(
      recordDecision(state(), human, { ...params, option: "merge" }, f.io),
    );
    if (status !== "missing") {
      record("queued");
      record("running");
      record("failed");
      f.commit(recheckMerge(state(), human, { card_id: f.card.id }, f.io));
      if (status !== "requeued") record("queued", "retry");
      if (!["queued", "requeued"].includes(status)) record("running", "retry");
      if (status === "passed" || status === "interrupted")
        record(status, "retry");
    }
    const before = JSON.stringify(f.state);
    expect(recordDecision(state(), human, params, f.io)).toMatchObject({
      ok: false,
      error: {
        code: "illegal_transition",
        message: expect.stringContaining("最新检查失败或超时"),
      },
    });
    expect(value(listNeedsYou(state(), human)).data.decisions).toEqual([]);
    expect(JSON.stringify(f.state)).toBe(before);
  },
);

test("failed confirmed returns still reject blank reasons, agents, stale checks and closed cards", async () => {
  const { f, state, record, product } = await fixture("confirm");
  const decision = f.state.decisions[0];
  if (!decision) throw new Error("Missing confirmation");
  const params = {
    decision_id: decision.id,
    option: "request_changes",
    rationale: "Fix",
    raw_quote: "Fix",
  };
  f.commit(
    recordDecision(state(), human, { ...params, option: "merge" }, f.io),
  );
  record("queued");
  record("running");
  record("failed");
  const before = JSON.stringify(f.state);
  for (const field of ["rationale", "raw_quote"] as const)
    expect(
      recordDecision(state(), human, { ...params, [field]: " \n " }, f.io).ok,
    ).toBe(false);
  for (const actor of [system, f.actor(f.coder), f.actor(f.pm)])
    expect(recordDecision(state(), actor, params, f.io).ok).toBe(false);
  const stale = {
    ...state(),
    events: state().events.map((e) =>
      e.type.startsWith("merge_check_")
        ? {
            ...e,
            payload: { ...(e.payload as object), completion_id: product.id },
          }
        : e,
    ),
  };
  expect(recordDecision(stale, human, params, f.io).ok).toBe(false);
  expect(value(listNeedsYou(stale, human)).data.decisions).toEqual([]);
  for (const status of ["done", "cancelled"] as const)
    expect(
      recordDecision(
        { ...state(), cards: state().cards.map((c) => ({ ...c, status })) },
        human,
        params,
        f.io,
      ).ok,
    ).toBe(false);
  expect(
    recordDecision(state(), human, { ...params, option: "hold" }, f.io).ok,
  ).toBe(false);
  expect(JSON.stringify(f.state)).toBe(before);
});

test("unreachable attempts never authorize a merge or require manual same-tree recheck", async () => {
  const { f, state, identity, record, merged } = await fixture();
  record("queued");
  const unreachable = {
    ...identity,
    status: "executor_unreachable" as const,
    checks: [],
    summary: "远程检查机不可达",
    log_ref: "attempt-1.log",
  };
  f.commit(recordMergeCheck(state(), system, unreachable, f.io));
  expect(
    hasPassedMergeCheck(
      state().events,
      identity.card_id,
      identity.completion_id,
      tree,
    ),
  ).toBe(false);
  expect(recordMergeResult(state(), system, merged, f.io).ok).toBe(false);
  expect(
    recheckMerge(state(), human, { card_id: identity.card_id }, f.io).ok,
  ).toBe(false);
  expect(
    value(recordMergeCheck(state(), system, unreachable, f.io)).events,
  ).toEqual([]);
  record("queued", "attempt-2");
  record("running", "attempt-2");
  record("passed", "attempt-2");
  expect(recordMergeResult(state(), system, merged, f.io).ok).toBe(true);
});

test("A3: skipped docs checks pass only for the same completion and tree", async () => {
  const { f, state, identity, merged } = await fixture();
  const scope = { kind: "docs_only" as const };
  for (const status of ["queued", "running"] as const)
    f.commit(
      recordMergeCheck(
        state(),
        system,
        { ...identity, ...(scope ? { scope } : {}), status },
        f.io,
      ),
    );
  const result = {
    ...identity,
    scope,
    status: "passed" as const,
    checks: [
      { name: "build", status: "passed" as const, exit_code: 0 },
      {
        name: "test",
        status: "skipped" as const,
        reason: "docs_only" as const,
      },
      { name: "e2e", status: "skipped" as const, reason: "docs_only" as const },
    ],
    summary: "Scoped checks passed",
    log_ref: "attempt-1.log",
  };
  f.commit(recordMergeCheck(state(), system, result, f.io));
  for (const event of state().events.slice(-3))
    expect(event.payload).toMatchObject({ scope });
  expect(
    value(projectSnapshot(state(), human)).data.cards[0]?.merge_check,
  ).toMatchObject({ scope, checks: result.checks, status: "passed" });
  expect(
    recordMergeResult(
      state(),
      system,
      { ...merged, result: { ...merged.result, tree_sha: "d".repeat(40) } },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    hasPassedMergeCheck(state().events, f.card.id, "D-999" as never, tree),
  ).toBe(false);
  expect(
    recordMergeCheck(
      state(),
      system,
      { ...result, scope: { kind: "full" } },
      f.io,
    ).ok,
  ).toBe(false);
  f.commit(recordMergeResult(state(), system, merged, f.io));
  expect(f.state.cards[0]?.status).toBe("done");
});

test.each([
  null,
  { kind: "unknown" },
  { kind: "full", packages: ["apps/web"] },
  { kind: "affected", packages: "apps/web" },
  { kind: "affected", packages: ["apps/web;exit"] },
])("A3: rejects malformed scope %j", async (scope) => {
  const { f, state, identity } = await fixture();
  expect(
    recordMergeCheck(
      state(),
      system,
      { ...identity, status: "queued", scope: scope as never },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});

test.each([
  undefined,
  { kind: "full" },
  { kind: "affected", packages: ["apps/web"] },
  { kind: "docs_only" },
] as const)("A3: validates skipped evidence for scope %j", async (scope) => {
  const { f, state, identity } = await fixture();
  for (const status of ["queued", "running"] as const)
    f.commit(
      recordMergeCheck(
        state(),
        system,
        { ...identity, ...(scope ? { scope } : {}), status },
        f.io,
      ),
    );
  const finish = {
    ...identity,
    ...(scope ? { scope } : {}),
    status: "passed" as const,
    summary: "ok",
    log_ref: "attempt-1.log",
  };
  for (const item of [
    { name: "test", status: "skipped" as const },
    {
      name: "test",
      status: "skipped" as const,
      reason: "docs_only" as const,
      exit_code: 1,
    },
    { name: "test", status: "not_run" as const },
  ])
    expect(
      recordMergeCheck(state(), system, { ...finish, checks: [item] }, f.io).ok,
    ).toBe(false);
  const result = recordMergeCheck(
    state(),
    system,
    {
      ...finish,
      checks: [{ name: "test", status: "skipped", reason: "docs_only" }],
    },
    f.io,
  );
  expect(result.ok).toBe(scope?.kind === "docs_only");
});

test("A3: a timeout alongside skipped checks retains the single rerun and its scope", async () => {
  const { f, state, identity } = await fixture();
  const scope = { kind: "docs_only" as const };
  for (const status of ["queued", "running"] as const)
    f.commit(
      recordMergeCheck(
        state(),
        system,
        { ...identity, ...(scope ? { scope } : {}), status },
        f.io,
      ),
    );
  f.commit(
    recordMergeCheck(
      state(),
      system,
      {
        ...identity,
        scope,
        status: "timed_out",
        timeout_only: true,
        checks: [
          { name: "build", status: "timed_out" },
          { name: "test", status: "skipped", reason: "docs_only" },
        ],
        summary: "timeout",
        log_ref: "attempt-1.log",
      },
      f.io,
    ),
  );
  expect(
    latestMergeCheck(state().events, f.card.id, identity.completion_id),
  ).toMatchObject({ status: "queued", scope, recheck_requested: true });
});
