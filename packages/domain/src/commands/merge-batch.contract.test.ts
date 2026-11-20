import { expect, test } from "vitest";
import {
  type Actor,
  abortMergeBatch,
  abortMergeBatchPublish,
  batchFailures,
  beginMergeBatchPublish,
  type CommandEffect,
  type CommandState,
  formBisectProbe,
  formMergeBatch,
  hasPassedMergeCheck,
  heldByMergeWindow,
  identifyMergeBatchCulprit,
  type MergeBatch,
  type MergeBatchMember,
  mergeBatches,
  mergeQueue,
  mergeStage,
  mergeWindowVersions,
  parseId,
  type Result,
  recheckMerge,
  recordDecision,
  recordMergeBatchCheck,
  recordMergeBatchResult,
  recordMergeCheck,
  recordMergeResult,
  referenceProjectSnapshot,
  referenceReadState,
  refreshMergeWindows,
  requeueMergeBatch,
  setMergeSolo,
  setMergeWindow,
  startMergeBatchBisect,
  updateCard,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { apply, human, role, value } from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const sha = (n: number) => n.toString(16).padStart(40, "0");
async function fixture(count = 3, flow_version = 1) {
  let previous: ReturnType<typeof mergeFixture> | undefined;
  const members: MergeBatchMember[] = [];
  for (let i = 0; i < count; i++) {
    const f = mergeFixture(
      flow_version >= 2 ? "confirm" : "auto",
      3,
      previous ? { state: previous.state, ports: previous.io } : undefined,
    );
    const { completion } = await f.accept();
    members.push({
      card_id: f.card.id,
      completion_id: completion.id,
      merge_sha: sha(10 + i),
      tree_sha: sha(20 + i),
    });
    previous = f;
  }
  if (!previous) throw new Error("Missing fixture");
  const io = previous.io;
  let state: CommandState = {
    ...previous.state,
    cards: previous.state.cards.map((card) => ({ ...card, flow_version })),
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
  for (const [i, m] of members.entries()) {
    const identity = {
      card_id: m.card_id,
      completion_id: m.completion_id,
      attempt_id: `card-${i}`,
      candidate_sha: m.merge_sha,
      tree_sha: m.tree_sha,
      base_sha: sha(1),
      level: "card" as const,
    };
    commit(
      recordMergeCheck(state, system, { ...identity, status: "queued" }, io),
    );
    commit(
      recordMergeCheck(state, system, { ...identity, status: "running" }, io),
    );
    commit(
      recordMergeCheck(
        state,
        system,
        {
          ...identity,
          status: "passed",
          checks: [{ name: "test", status: "passed", exit_code: 0 }],
          summary: "Passed",
          log_ref: `card-${i}.log`,
        },
        io,
      ),
    );
  }
  if (flow_version >= 2) {
    for (const decision of state.decisions.filter(
      (q) => q.trigger === "merge_confirmation" && q.status === "open",
    ))
      commit(
        recordDecision(
          state,
          human,
          {
            decision_id: decision.id,
            option: "merge",
            rationale: "Approved test candidate",
            raw_quote: "Merge",
          },
          io,
        ),
      );
  }
  const form = () =>
    commit(
      formMergeBatch(
        state,
        system,
        { base_sha: sha(1), members, solo: false },
        io,
      ),
    );
  const check = (
    batch: MergeBatch,
    status: "passed" | "failed" | "repository_busy",
    attempt = `batch-${batch.id}`,
    summary = status as string,
  ) => {
    const last = batch.members.at(-1);
    if (!last) throw new Error("Missing member");
    const identity = {
      card_id: last.card_id,
      completion_id: last.completion_id,
      attempt_id: attempt,
      candidate_sha: batch.final_sha,
      tree_sha: batch.final_tree_sha,
      base_sha: batch.base_sha,
      level: "batch" as const,
      scope: { kind: "full" as const },
    };
    const p = {
      batch_id: batch.id,
      completion_ids: batch.members.map((m) => m.completion_id),
    };
    commit(
      recordMergeBatchCheck(
        state,
        system,
        { ...p, check: { ...identity, status: "queued" } },
        io,
      ),
    );
    if (status === "repository_busy") {
      commit(
        recordMergeBatchCheck(
          state,
          system,
          {
            ...p,
            check: {
              ...identity,
              status: "failed",
              startup_failure: status,
              checks: [],
              summary,
              log_ref: `${attempt}.log`,
            },
          },
          io,
        ),
      );
      return;
    }
    commit(
      recordMergeBatchCheck(
        state,
        system,
        { ...p, check: { ...identity, status: "running" } },
        io,
      ),
    );
    commit(
      recordMergeBatchCheck(
        state,
        system,
        {
          ...p,
          check: {
            ...identity,
            status,
            checks: [
              { name: "test", status, exit_code: status === "passed" ? 0 : 1 },
            ],
            summary,
            log_ref: `${attempt}.log`,
          },
        },
        io,
      ),
    );
  };
  return { state: () => state, members, io, commit, form, check };
}

test("MB identifiers do not alias members, and card checks cannot authorize publication", async () => {
  expect(parseId("merge_batch", "MB-12").ok).toBe(true);
  expect(parseId("member", "MB-12").ok).toBe(false);
  const f = await fixture();
  expect(mergeQueue(f.state())).toHaveLength(3);
  const m = f.members[0] as MergeBatchMember;
  expect(
    hasPassedMergeCheck(
      f.state().events,
      m.card_id,
      m.completion_id,
      m.tree_sha,
      sha(1),
    ),
  ).toBe(false);
  expect(
    recordMergeResult(
      f.state(),
      system,
      {
        card_id: m.card_id,
        completion_id: m.completion_id,
        result: {
          kind: "merged",
          merge_sha: m.merge_sha,
          previous_sha: sha(1),
          tree_sha: m.tree_sha,
        },
      },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    formMergeBatch(
      f.state(),
      human,
      { base_sha: sha(1), members: f.members, solo: false },
      f.io,
    ).ok,
  ).toBe(false);
});

test("one batch owns all three cards and only a passed final tree publishes all members atomically", async () => {
  const f = await fixture(),
    batch = f.form();
  expect(mergeQueue(f.state())).toHaveLength(0);
  expect(
    formMergeBatch(
      f.state(),
      system,
      { base_sha: sha(1), members: f.members, solo: false },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    recordMergeBatchResult(f.state(), system, { batch_id: batch.id }, f.io).ok,
  ).toBe(false);
  f.check(batch, "passed");
  f.commit(
    beginMergeBatchPublish(f.state(), system, { batch_id: batch.id }, f.io),
  );
  expect(
    abortMergeBatch(
      f.state(),
      system,
      { batch_id: batch.id, reason: "interrupted" },
      f.io,
    ).ok,
  ).toBe(false);
  expect(
    updateCard(
      f.state(),
      human,
      { card_id: f.members[0]!.card_id, status: "cancelled" },
      f.io,
    ).ok,
  ).toBe(false);
  const published = value(
    recordMergeBatchResult(f.state(), system, { batch_id: batch.id }, f.io),
  );
  expect(published.events.filter((e) => e.type === "card_merged")).toHaveLength(
    3,
  );
  expect(
    published.changes.filter(
      (c) => c.collection === "cards" && c.entity.status === "done",
    ),
  ).toHaveLength(3);
  f.commit({ ok: true, value: published });
  expect(
    value(
      recordMergeBatchResult(f.state(), system, { batch_id: batch.id }, f.io),
    ).events,
  ).toEqual([]);
});

test.each(
  [1, 2, 5].flatMap((flow) =>
    [1, 2, 3, 4].map((position) => [flow, position] as const),
  ),
)(
  "flow %i prefix evidence locates bad card %i without rejecting other members",
  async (flow, position) => {
    const f = await fixture(4, flow),
      batch = f.form();
    f.check(batch, "failed");
    f.commit(
      startMergeBatchBisect(f.state(), system, { batch_id: batch.id }, f.io),
    );
    const probes: MergeBatch[] = [];
    for (let length = 1; length < 4; length++) {
      const probe = f.commit(
        formBisectProbe(
          f.state(),
          system,
          { batch_id: batch.id, length },
          f.io,
        ),
      );
      probes.push(probe);
      f.check(probe, length < position ? "passed" : "failed");
    }
    const failed = position === 4 ? batch : probes[position - 1]!;
    const params = {
      batch_id: batch.id,
      failed_batch_id: failed.id,
      ...(position > 1 ? { passed_prefix_id: probes[position - 2]!.id } : {}),
    };
    if (position === 4) {
      expect(
        identifyMergeBatchCulprit(f.state(), system, params, f.io).ok,
      ).toBe(false);
      f.commit(
        requeueMergeBatch(f.state(), system, { batch_id: batch.id }, f.io),
      );
      f.check(batch, "failed", "confirm-main");
    }
    expect(
      f.commit(identifyMergeBatchCulprit(f.state(), system, params, f.io)),
    ).toBe(f.members[position - 1]!.card_id);
    expect(
      f.members.map(
        (m) => f.state().cards.find((c) => c.id === m.card_id)?.status,
      ),
    ).toEqual(
      f.members.map((_, i) =>
        flow >= 2 && i === position - 1 ? "in_progress" : "awaiting_merge",
      ),
    );
    const returned = f
      .state()
      .events.filter((e) => e.type === "merge_changes_requested");
    expect(returned).toHaveLength(flow >= 2 ? 1 : 0);
    if (flow >= 2) {
      expect(returned[0]?.payload).toMatchObject({
        completion_id: f.members[position - 1]!.completion_id,
        via: "system_rule",
        run_kind: "fix",
      });
      expect(
        f
          .state()
          .deliveries.find(
            (d) => d.id === f.members[position - 1]!.completion_id,
          )?.status,
      ).toBe("superseded");
      expect(
        identifyMergeBatchCulprit(f.state(), system, params, f.io).ok,
      ).toBe(false);
    }
    if (position > 1) {
      const prefix = probes[position - 2]!;
      f.commit(
        beginMergeBatchPublish(
          f.state(),
          system,
          { batch_id: prefix.id },
          f.io,
        ),
      );
      f.commit(
        recordMergeBatchResult(
          f.state(),
          system,
          { batch_id: prefix.id },
          f.io,
        ),
      );
    }
    expect(mergeQueue(f.state()).map((q) => q.plan.card_id)).toEqual(
      f.members.slice(position).map((m) => m.card_id),
    );
  },
);

test.each(["passed", "failed"] as const)(
  "a solo failure needs a second attempt (%s)",
  async (second) => {
    const f = await fixture(1),
      batch = f.form();
    f.check(batch, "failed");
    expect(
      identifyMergeBatchCulprit(
        f.state(),
        system,
        { batch_id: batch.id, failed_batch_id: batch.id },
        f.io,
      ).ok,
    ).toBe(false);
    f.commit(
      requeueMergeBatch(f.state(), system, { batch_id: batch.id }, f.io),
    );
    f.check(batch, second, "confirmation");
    if (second === "passed") {
      f.commit(
        beginMergeBatchPublish(f.state(), system, { batch_id: batch.id }, f.io),
      );
      f.commit(
        recordMergeBatchResult(f.state(), system, { batch_id: batch.id }, f.io),
      );
      expect(f.state().cards[0]?.status).toBe("done");
    } else {
      f.commit(
        identifyMergeBatchCulprit(
          f.state(),
          system,
          { batch_id: batch.id, failed_batch_id: batch.id },
          f.io,
        ),
      );
      expect(mergeQueue(f.state())).toEqual([]);
    }
  },
);

test.each(["main", "probe"])(
  "C-533: a repository-busy %s cannot confirm a failure or implicate a batch member",
  async (kind) => {
    const f = await fixture(2, 2),
      batch = f.form();
    let target = batch;
    if (kind === "probe") {
      f.check(batch, "failed");
      f.commit(
        startMergeBatchBisect(f.state(), system, { batch_id: batch.id }, f.io),
      );
      target = f.commit(
        formBisectProbe(
          f.state(),
          system,
          { batch_id: batch.id, length: 1 },
          f.io,
        ),
      );
    }
    f.check(target, "repository_busy");
    const id = { batch_id: target.id };
    expect(startMergeBatchBisect(f.state(), system, id, f.io).ok).toBe(false);
    expect(requeueMergeBatch(f.state(), system, id, f.io).ok).toBe(false);
    expect(batchFailures(f.state().events, target.id)).toEqual([]);
    expect(
      identifyMergeBatchCulprit(
        f.state(),
        system,
        { batch_id: batch.id, failed_batch_id: target.id },
        f.io,
      ).ok,
    ).toBe(false);
    expect(beginMergeBatchPublish(f.state(), system, id, f.io).ok).toBe(false);
    f.commit(
      abortMergeBatch(
        f.state(),
        system,
        { batch_id: batch.id, reason: "repository_busy" },
        f.io,
      ),
    );
    expect(mergeQueue(f.state())).toEqual([]);
    expect(
      f.state().events.filter((e) => e.type === "merge_batch_member_deferred"),
    ).toHaveLength(2);
    const [first] = f.members;
    if (!first) throw new Error("Missing first member");
    const { card_id } = first;
    f.commit(recheckMerge(f.state(), human, { card_id }, f.io));
    expect(recheckMerge(f.state(), human, { card_id }, f.io).ok).toBe(false);
    expect(mergeQueue(f.state()).map((q) => q.plan.card_id)).toEqual([card_id]);
  },
);

test("stale publishing recovery is system-only and refuses original/final baselines", async () => {
  const f = await fixture(),
    batch = f.form();
  f.check(batch, "passed");
  f.commit(
    beginMergeBatchPublish(f.state(), system, { batch_id: batch.id }, f.io),
  );
  for (const observed_base_sha of [batch.base_sha, batch.final_sha])
    expect(
      abortMergeBatchPublish(
        f.state(),
        system,
        { batch_id: batch.id, observed_base_sha },
        f.io,
      ).ok,
    ).toBe(false);
  expect(
    abortMergeBatchPublish(
      f.state(),
      human,
      { batch_id: batch.id, observed_base_sha: sha(99) },
      f.io,
    ).ok,
  ).toBe(false);
  f.commit(
    abortMergeBatchPublish(
      f.state(),
      system,
      { batch_id: batch.id, observed_base_sha: sha(99) },
      f.io,
    ),
  );
  expect(mergeBatches(f.state().events)[0]?.status).toBe("aborted");
  expect(mergeQueue(f.state())).toHaveLength(3);
});

test("merge windows hold intersecting paths and preserve consent and queue positions on close", async () => {
  const f = await fixture();
  const [one, two, three] = f.members;
  if (!one || !two || !three) throw new Error("Missing cards");
  const before = f.state().decisions;
  f.commit(
    setMergeWindow(
      f.state(),
      human,
      { card_id: one.card_id, open: true, reason: "Protect shared file" },
      f.io,
    ),
  );
  expect(heldByMergeWindow(f.state(), two.card_id)).toBe(one.card_id); // Unknown paths fail closed.
  f.commit(
    refreshMergeWindows(
      f.state(),
      system,
      {
        paths: f.members.map((m, i) => ({
          card_id: m.card_id,
          versions: mergeWindowVersions(f.state(), m.card_id),
          files: [i < 2 ? "shared.ts" : "separate.ts"],
        })),
      },
      f.io,
    ),
  );
  expect(mergeQueue(f.state()).map((q) => q.plan.card_id)).toEqual([
    one.card_id,
    three.card_id,
  ]);
  expect(
    formMergeBatch(
      f.state(),
      system,
      { base_sha: sha(1), members: [two], solo: false },
      f.io,
    ).ok,
  ).toBe(false);
  f.commit(
    setMergeWindow(
      f.state(),
      human,
      { card_id: one.card_id, open: false, reason: "Done" },
      f.io,
    ),
  );
  expect(mergeQueue(f.state()).map((q) => q.plan.card_id)).toEqual(
    f.members.map((m) => m.card_id),
  );
  expect(f.state().decisions).toEqual(before);
});

test("intersecting windows respect opening order and expiry releases waiting cards", async () => {
  const f = await fixture();
  const [one, two] = f.members;
  if (!one || !two) throw new Error("Missing cards");
  f.commit(
    setMergeWindow(
      f.state(),
      human,
      { card_id: one.card_id, open: true, reason: "First" },
      f.io,
    ),
  );
  f.commit(
    setMergeWindow(
      f.state(),
      human,
      { card_id: two.card_id, open: true, reason: "Second" },
      f.io,
    ),
  );
  f.commit(
    refreshMergeWindows(
      f.state(),
      system,
      {
        paths: f.members.map((m) => ({
          card_id: m.card_id,
          versions: mergeWindowVersions(f.state(), m.card_id),
          files: ["shared.ts"],
        })),
      },
      f.io,
    ),
  );
  expect(heldByMergeWindow(f.state(), one.card_id)).toBeUndefined();
  expect(heldByMergeWindow(f.state(), two.card_id)).toBe(one.card_id);
  const later = {
    ...f.io,
    clock: {
      now: () =>
        new Date(Date.parse(f.io.clock.now()) + 86_400_001).toISOString(),
    },
  };
  f.commit(refreshMergeWindows(f.state(), system, { paths: [] }, later));
  expect(mergeQueue(f.state())).toHaveLength(3);
});

test("solo changes do not mutate an existing batch and new batches enforce the flag", async () => {
  const f = await fixture(),
    member = f.members[1];
  if (!member) throw new Error("Missing card");
  f.commit(
    setMergeSolo(
      f.state(),
      human,
      { card_id: member.card_id, solo: true, reason: "Isolate" },
      f.io,
    ),
  );
  expect(
    formMergeBatch(
      f.state(),
      system,
      { base_sha: sha(1), members: f.members, solo: false },
      f.io,
    ).ok,
  ).toBe(false);
  const batch = f.commit(
    formMergeBatch(
      f.state(),
      system,
      { base_sha: sha(1), members: [member], solo: true },
      f.io,
    ),
  );
  f.commit(
    setMergeSolo(
      f.state(),
      human,
      { card_id: member.card_id, solo: false, reason: "Next batch" },
      f.io,
    ),
  );
  expect(
    mergeBatches(f.state().events).find((b) => b.id === batch.id)?.solo,
  ).toBe(true);
});

test("batch culprit recheck restores original queue position without repeating card checks or confirmation", async () => {
  const f = await fixture(1),
    batch = f.form();
  f.check(batch, "failed");
  f.commit(requeueMergeBatch(f.state(), system, { batch_id: batch.id }, f.io));
  f.check(batch, "failed", "retry");
  f.commit(
    identifyMergeBatchCulprit(
      f.state(),
      system,
      { batch_id: batch.id, failed_batch_id: batch.id },
      f.io,
    ),
  );
  const member = f.members[0];
  if (!member) throw new Error("Missing member");
  expect(mergeQueue(f.state())).toHaveLength(0);
  f.commit(recheckMerge(f.state(), human, { card_id: member.card_id }, f.io));
  expect(mergeQueue(f.state()).map((q) => q.plan.card_id)).toEqual([
    member.card_id,
  ]);
});

test("legal culprit evidence and historical timeline copies honor current cross-card access", async () => {
  const f = await fixture(2);
  const batch = f.form();
  const secret = "SYNTHETIC_BATCH_PRIVATE_DIAGNOSTIC";
  f.check(batch, "failed", "first", secret);
  f.commit(
    startMergeBatchBisect(f.state(), system, { batch_id: batch.id }, f.io),
  );
  const prefix = f.commit(
    formBisectProbe(f.state(), system, { batch_id: batch.id, length: 1 }, f.io),
  );
  f.check(prefix, "passed");
  f.commit(requeueMergeBatch(f.state(), system, { batch_id: batch.id }, f.io));
  f.check(batch, "failed", "confirmation", secret);
  f.commit(
    identifyMergeBatchCulprit(
      f.state(),
      system,
      {
        batch_id: batch.id,
        failed_batch_id: batch.id,
        passed_prefix_id: prefix.id,
      },
      f.io,
    ),
  );
  const original = f.state();
  const culprit = f.members[1]!;
  const owner = original.assignments.find(
    (a) =>
      a.scope === "work_item" &&
      original.work_items.some(
        (w) =>
          w.id === a.work_item_id &&
          w.kind === "produce" &&
          w.card_id === culprit.card_id,
      ),
  )!;
  const caller: Actor = {
    kind: "assignment",
    project_id: original.project_id,
    assignment_id: owner.id,
    ...role(owner.role_id),
  };
  expect(JSON.stringify(referenceReadState(original, owner))).toContain(secret);
  for (const state of [
    {
      ...original,
      cards: original.cards.map((c) =>
        c.id === f.members[0]!.card_id ? { ...c, sensitive: true } : c,
      ),
    },
    {
      ...original,
      project_preferences: [
        {
          id: original.project_id,
          auto_merge_after_minutes: null,
          cross_card_read: false,
        },
      ],
    },
    {
      ...original,
      cards: original.cards.filter((c) => c.id !== f.members[0]!.card_id),
    },
  ]) {
    const filtered = referenceReadState(state, owner);
    expect(JSON.stringify(filtered.events)).not.toContain(secret);
    expect(JSON.stringify(filtered.timeline)).not.toContain(secret);
    expect(
      filtered.events.findLast(
        (e) =>
          e.card_id === culprit.card_id && e.type === "merge_check_finished",
      )?.payload,
    ).toMatchObject({ status: "failed", checks: [] });
    expect(
      JSON.stringify(referenceProjectSnapshot(state, caller)),
    ).not.toContain(secret);
  }
  expect(JSON.stringify(original.timeline)).toContain(secret);
  // A new completion must never inherit a previous batch's culprit label.
  const completion = original.deliveries.find(
    (d) => d.id === culprit.completion_id,
  )!;
  const next = {
    ...original,
    deliveries: [
      ...original.deliveries.map((d) =>
        d.id === completion.id ? { ...d, status: "superseded" as const } : d,
      ),
      { ...completion, id: "D-99999" as typeof completion.id },
    ],
  };
  expect(
    mergeStage(next, original.cards.find((c) => c.id === culprit.card_id)!)
      ?.stage,
  ).not.toBe("culprit");
});
