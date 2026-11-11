import { expect, test } from "vitest";
import {
  type Actor,
  autoConfirmMerge,
  createHostOpsAssignment,
  HOST_OPS_ROLE_TOOLS,
  hasPassedMergeCheck,
  latestMergeCheck,
  listNeedsYou,
  type MergeCheckView,
  mergePlan,
  prepareMergePlan,
  projectSnapshot,
  recheckMerge,
  recordDecision,
  recordMergeCheck,
  recordMergeResult,
  requestDecision,
  setProjectPreferences,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { apply, human, value } from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const tree = "c".repeat(40),
  candidate = "b".repeat(40);

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
      const pending = value(listNeedsYou(state(), human)).data.decisions;
      expect(pending.map((q) => q.id)).toContain(decision.id);
      expect(
        pending.find((q) => q.id === decision.id)?.followup_notice,
      ).toBeUndefined();
      if (approval !== "open")
        expect(pending[0]?.options.map((o) => o.key)).toEqual([
          "request_changes",
        ]);
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
