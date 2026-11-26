import { expect, test } from "vitest";
import {
  type Actor,
  beginMergeBatchPublish,
  type CommandEffect,
  type CommandState,
  type Event,
  formMergeBatch,
  hasPassedMergeCheck,
  latestMergeCheck,
  mergeBatches,
  PRECHECK_REUSE_SUMMARY,
  passedCardCheck,
  type Result,
  recordDecision,
  recordMergeBatchCheck,
  recordMergeCheck,
  recordMergeResult,
  reusablePrecheck,
  reusePrecheckForCardCheck,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { apply, human, value } from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const sha = (n: number) => n.toString(16).padStart(40, "0");
const HEAD = "a".repeat(40);
const REQUIRED = ["install", "build", "test", "lint", "deps"];
const PRECHECK_RUN = {
  provider: "github" as const,
  run_id: 4242,
  run_attempt: 1,
  html_url: "https://github.com/acme/app/actions/runs/4242",
  workflow_sha: sha(9),
};
const allPassed = [...REQUIRED, "e2e"].map((name) => ({
  name,
  status: "passed" as const,
  exit_code: 0,
}));

/** A flow-5 queue card whose only producer delivered HEAD and was accepted. */
async function fixture(flow_version = 5) {
  const f = mergeFixture("confirm");
  const { completion, product } = await f.accept();
  let state: CommandState = {
    ...f.state,
    cards: f.state.cards.map((c) => ({ ...c, flow_version })),
    project_settings: {
      merge_gate_enabled: true,
      merge_queue: { max_batch_size: 4 },
    },
  };
  const commit = <T>(r: Result<CommandEffect<T>>) => {
    const effect = value(r);
    state = apply(state, effect);
    return effect.data;
  };
  /** A host-recorded terminal precheck of the producer (system event). */
  const precheck = (
    attempt_id: string,
    overrides: Record<string, unknown> = {},
    actor: Actor = system,
  ) => {
    const event: Event = {
      id: f.io.ids.nextEventId(),
      seq: f.io.ids.nextEventSequence(human.project_id, f.card.id),
      type: "precheck_finished",
      card_id: f.card.id,
      actor,
      created_at: "2026-01-01T00:00:00Z",
      payload: {
        attempt_id,
        assignment_id: f.coder.id,
        work_item_id: product.work_item_id,
        card_id: f.card.id,
        head_sha: HEAD,
        status: "passed",
        branch: "agent/fixture",
        machine_id: "local",
        candidate_sha: sha(31),
        tree_sha: sha(32),
        base_sha: sha(33),
        executor: { name: "github-actions", type: "github" },
        external_run: PRECHECK_RUN,
        checks: allPassed,
        summary: "检查全部通过",
        log_ref: `${attempt_id}.log`,
        ...overrides,
      },
    };
    state = { ...state, events: [...state.events, event] };
  };
  const reuse = (attempt_id = "reuse-1", precheck_attempt_id = "pre-1") =>
    reusePrecheckForCardCheck(
      state,
      system,
      {
        card_id: f.card.id,
        completion_id: completion.id,
        attempt_id,
        precheck_attempt_id,
        required_checks: REQUIRED,
      },
      f.io,
    );
  return {
    f,
    completion,
    product,
    precheck,
    reuse,
    commit,
    state: () => state,
    set: (next: CommandState) => {
      state = next;
    },
  };
}

test("C-781 a queue card check reuses the passed same-head precheck as an explicit, bound record", async () => {
  const t = await fixture();
  t.precheck("pre-1");
  expect(
    reusablePrecheck(t.state(), t.f.card.id, REQUIRED)?.precheck.attempt_id,
  ).toBe("pre-1");
  const recorded = t.commit(t.reuse());
  expect(recorded).toMatchObject({
    level: "card",
    status: "passed",
    attempt_id: "reuse-1",
    completion_id: t.completion.id,
    // The precheck's own candidate, tree and baseline: what was checked.
    candidate_sha: sha(31),
    tree_sha: sha(32),
    base_sha: sha(33),
    summary: PRECHECK_REUSE_SUMMARY,
    log_ref: "reuse-1.log",
    reused_precheck: {
      attempt_id: "pre-1",
      work_item_id: t.product.work_item_id,
      head_sha: HEAD,
      delivery_id: t.product.id,
    },
  });
  const events = t
    .state()
    .events.filter(
      (e) =>
        e.type === "merge_check_finished" &&
        (e.payload as { attempt_id?: string }).attempt_id === "reuse-1",
    );
  // Exactly one system fact, no queued/started: nothing was executed.
  expect(events).toHaveLength(1);
  expect(events[0]?.actor).toEqual(system);
  expect(
    t
      .state()
      .events.some(
        (e) =>
          ["merge_check_queued", "merge_check_started"].includes(e.type) &&
          (e.payload as { attempt_id?: string }).attempt_id === "reuse-1",
      ),
  ).toBe(false);
  expect(
    passedCardCheck(t.state().events, t.f.card.id, t.completion.id),
  ).toMatchObject({ attempt_id: "reuse-1" });
  expect(
    latestMergeCheck(t.state().events, t.f.card.id, t.completion.id),
  ).toMatchObject({ attempt_id: "reuse-1", status: "passed" });
  expect(t.state().timeline.at(-1)?.body).toContain("沿用作者预检 pre-1");
  // A second reuse for the same completion is refused: it already has a result.
  expect(t.reuse("reuse-2")).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
});

test("C-781/C-328 the reused record never binds the precheck's GitHub run as a card check run", async () => {
  const t = await fixture();
  t.precheck("pre-1");
  const recorded = t.commit(t.reuse());
  expect(recorded.external_run).toBeUndefined();
  expect(recorded.executor).toBeUndefined();
  const payload = t.state().events.at(-1)?.payload as Record<string, unknown>;
  expect(payload.external_run).toBeUndefined();
  expect(payload.executor).toBeUndefined();
  expect(JSON.stringify(payload)).not.toContain(String(PRECHECK_RUN.run_id));
  // The precheck's run cannot be attached to the reused attempt afterwards.
  const identity = {
    card_id: t.f.card.id,
    completion_id: t.completion.id,
    attempt_id: "reuse-1",
    candidate_sha: sha(31),
    tree_sha: sha(32),
    base_sha: sha(33),
    level: "card" as const,
    executor: { name: "github-actions", type: "github" as const },
    external_run: PRECHECK_RUN,
  };
  for (const status of ["queued", "running"] as const)
    expect(
      recordMergeCheck(t.state(), system, { ...identity, status }, t.f.io).ok,
    ).toBe(false);
  // A real card check still needs its own trusted run for a GitHub executor.
  const { external_run: _run, ...unbound } = identity;
  const fresh = { ...unbound, attempt_id: "card-real" };
  const other = await fixture();
  other.precheck("pre-1", { head_sha: "b".repeat(40) });
  other.commit(
    recordMergeCheck(
      other.state(),
      system,
      { ...fresh, completion_id: other.completion.id, status: "queued" },
      other.f.io,
    ),
  );
  expect(
    recordMergeCheck(
      other.state(),
      system,
      {
        ...fresh,
        completion_id: other.completion.id,
        status: "passed",
        checks: allPassed.slice(0, 5),
        summary: "ok",
        log_ref: "card-real.log",
      },
      other.f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});

test("C-781 a card with more than one producer never reuses a precheck", async () => {
  const t = await fixture();
  t.precheck("pre-1");
  const producer = t
    .state()
    .work_items.find((w) => w.id === t.product.work_item_id);
  if (!producer) throw new Error("Missing producer");
  t.set({
    ...t.state(),
    work_items: [
      ...t.state().work_items,
      { ...producer, id: "W-999" as typeof producer.id },
    ],
  });
  expect(reusablePrecheck(t.state(), t.f.card.id, REQUIRED)).toBeUndefined();
  expect(t.reuse()).toMatchObject({
    ok: false,
    error: { code: "illegal_transition" },
  });
  // A cancelled second producer does not count.
  t.set({
    ...t.state(),
    work_items: t
      .state()
      .work_items.map((w) =>
        w.id === "W-999" ? { ...w, status: "cancelled" as const } : w,
      ),
  });
  expect(t.reuse().ok).toBe(true);
});

test.each([
  ["another head", { head_sha: "b".repeat(40) }],
  ["a failed precheck", { status: "failed" }],
  ["an interrupted precheck", { status: "interrupted" }],
  [
    "a precheck missing a card-tier check",
    { checks: allPassed.filter((c) => c.name !== "lint") },
  ],
  ["a precheck of another work item", { work_item_id: "W-998" }],
  ["a precheck without a tree", { tree_sha: undefined }],
])("C-781 %s is never reused", async (_name, overrides) => {
  const t = await fixture();
  t.precheck("pre-1", overrides);
  expect(reusablePrecheck(t.state(), t.f.card.id, REQUIRED)).toBeUndefined();
  expect(t.reuse().ok).toBe(false);
});

test("C-781 only a system precheck counts", async () => {
  const t = await fixture();
  t.precheck("pre-1", {}, human);
  expect(reusablePrecheck(t.state(), t.f.card.id, REQUIRED)).toBeUndefined();
});

test("C-781 reuse needs the merge queue, flow >= 3, no hold and a system caller", async () => {
  const noQueue = await fixture();
  noQueue.precheck("pre-1");
  noQueue.set({
    ...noQueue.state(),
    project_settings: { merge_gate_enabled: true },
  });
  // Invariant 21(a): a single-level check is merge evidence; never reused.
  expect(noQueue.reuse().ok).toBe(false);
  const legacy = await fixture(2);
  legacy.precheck("pre-1");
  expect(legacy.reuse().ok).toBe(false);
  const held = await fixture();
  held.precheck("pre-1");
  held.set({
    ...held.state(),
    cards: held.state().cards.map((c) => ({
      ...c,
      hold: {
        reason: "paused",
        resume_condition: "manual",
        set_by: "human" as const,
        set_at: "2026-01-01T00:00:00.000Z",
      },
    })),
  });
  expect(held.reuse().ok).toBe(false);
  const agent = await fixture();
  agent.precheck("pre-1");
  expect(
    reusePrecheckForCardCheck(
      agent.state(),
      human,
      {
        card_id: agent.f.card.id,
        completion_id: agent.completion.id,
        attempt_id: "reuse-1",
        precheck_attempt_id: "pre-1",
        required_checks: REQUIRED,
      },
      agent.f.io,
    ).ok,
  ).toBe(false);
  // The precheck attempt must be exactly the reusable one.
  expect(agent.reuse("reuse-1", "pre-other").ok).toBe(false);
  expect(
    reusePrecheckForCardCheck(
      agent.state(),
      system,
      {
        card_id: agent.f.card.id,
        completion_id: agent.completion.id,
        attempt_id: "reuse-1",
        precheck_attempt_id: "pre-1",
        required_checks: [],
      },
      agent.f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});

test("C-781 a completion whose card check already failed runs a real check; an interrupted one may reuse", async () => {
  const t = await fixture();
  t.precheck("pre-1");
  const identity = {
    card_id: t.f.card.id,
    completion_id: t.completion.id,
    attempt_id: "card-1",
    candidate_sha: sha(41),
    tree_sha: sha(42),
    base_sha: sha(43),
    level: "card" as const,
  };
  t.commit(
    recordMergeCheck(
      t.state(),
      system,
      { ...identity, status: "queued" },
      t.f.io,
    ),
  );
  t.commit(
    recordMergeCheck(
      t.state(),
      system,
      {
        ...identity,
        status: "interrupted",
        checks: [],
        summary: "检查中断或候选已改变，重新排队",
        log_ref: "card-1.log",
      },
      t.f.io,
    ),
  );
  expect(reusablePrecheck(t.state(), t.f.card.id, REQUIRED)).toBeDefined();
  const failed = await fixture(2);
  failed.precheck("pre-1");
  failed.set({
    ...failed.state(),
    cards: failed.state().cards.map((c) => ({ ...c, flow_version: 1 })),
  });
  const failedIdentity = { ...identity, completion_id: failed.completion.id };
  failed.commit(
    recordMergeCheck(
      failed.state(),
      system,
      { ...failedIdentity, status: "queued" },
      failed.f.io,
    ),
  );
  failed.commit(
    recordMergeCheck(
      failed.state(),
      system,
      { ...failedIdentity, status: "running" },
      failed.f.io,
    ),
  );
  failed.commit(
    recordMergeCheck(
      failed.state(),
      system,
      {
        ...failedIdentity,
        status: "failed",
        checks: [{ name: "test", status: "failed", exit_code: 1 }],
        summary: "test failed",
        log_ref: "card-1.log",
      },
      failed.f.io,
    ),
  );
  failed.set({
    ...failed.state(),
    cards: failed.state().cards.map((c) => ({ ...c, flow_version: 5 })),
  });
  expect(
    reusablePrecheck(failed.state(), failed.f.card.id, REQUIRED),
  ).toBeUndefined();
  expect(failed.reuse().ok).toBe(false);
});

test("C-781/invariant 21 a reused card pass never authorizes merged; only the batch check does", async () => {
  const t = await fixture();
  t.precheck("pre-1");
  t.commit(t.reuse());
  const events = t.state().events;
  expect(
    hasPassedMergeCheck(events, t.f.card.id, t.completion.id, sha(32), sha(33)),
  ).toBe(false);
  expect(
    recordMergeResult(
      t.state(),
      system,
      {
        card_id: t.f.card.id,
        completion_id: t.completion.id,
        result: {
          kind: "merged",
          merge_sha: sha(31),
          previous_sha: sha(33),
          tree_sha: sha(32),
        },
      },
      t.f.io,
    ).ok,
  ).toBe(false);
  for (const q of t
    .state()
    .decisions.filter(
      (q) => q.trigger === "merge_confirmation" && q.status === "open",
    ))
    t.commit(
      recordDecision(
        t.state(),
        human,
        {
          decision_id: q.id,
          option: "merge",
          rationale: "Approved",
          raw_quote: "Merge",
        },
        t.f.io,
      ),
    );
  const member = {
    card_id: t.f.card.id,
    completion_id: t.completion.id,
    merge_sha: sha(51),
    tree_sha: sha(52),
  };
  // The reused card pass admits the card to the queue like any card pass.
  t.commit(
    formMergeBatch(
      t.state(),
      system,
      { base_sha: sha(50), members: [member], solo: false },
      t.f.io,
    ),
  );
  const batch = mergeBatches(t.state().events).at(-1);
  if (!batch) throw new Error("Missing batch");
  const publish = () =>
    beginMergeBatchPublish(t.state(), system, { batch_id: batch.id }, t.f.io);
  expect(publish().ok).toBe(false);
  const identity = {
    card_id: t.f.card.id,
    completion_id: t.completion.id,
    attempt_id: "batch-1",
    candidate_sha: batch.final_sha,
    tree_sha: batch.final_tree_sha,
    base_sha: batch.base_sha,
    level: "batch" as const,
    scope: { kind: "full" as const },
  };
  const p = { batch_id: batch.id, completion_ids: [t.completion.id] };
  for (const status of ["queued", "running"] as const)
    t.commit(
      recordMergeBatchCheck(
        t.state(),
        system,
        { ...p, check: { ...identity, status } },
        t.f.io,
      ),
    );
  t.commit(
    recordMergeBatchCheck(
      t.state(),
      system,
      {
        ...p,
        check: {
          ...identity,
          status: "failed",
          checks: [{ name: "test", status: "failed", exit_code: 1 }],
          summary: "test failed",
          log_ref: "batch-1.log",
        },
      },
      t.f.io,
    ),
  );
  // A failure the reused card check could not see is still stopped here.
  expect(mergeBatches(t.state().events).at(-1)?.status).not.toBe("passed");
  expect(publish().ok).toBe(false);
  expect(t.state().cards.find((c) => c.id === t.f.card.id)?.status).toBe(
    "awaiting_merge",
  );
});
