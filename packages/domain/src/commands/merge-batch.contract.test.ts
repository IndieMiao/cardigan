import { expect, test } from "vitest";
import {
  type Actor,
  abortMergeBatch,
  abortMergeBatchPublish,
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
  mergeWindowVersions,
  parseId,
  type Result,
  recheckMerge,
  recordMergeBatchCheck,
  recordMergeBatchResult,
  recordMergeCheck,
  recordMergeResult,
  refreshMergeWindows,
  requeueMergeBatch,
  setMergeSolo,
  setMergeWindow,
  startMergeBatchBisect,
  updateCard,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { apply, human, value } from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const sha = (n: number) => n.toString(16).padStart(40, "0");
async function fixture(count = 3) {
  let previous: ReturnType<typeof mergeFixture> | undefined;
  const members: MergeBatchMember[] = [];
  for (let i = 0; i < count; i++) {
    const f = mergeFixture(
      "auto",
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
    status: "passed" | "failed",
    attempt = `batch-${batch.id}`,
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
            summary: status,
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

test.each([1, 2, 3, 4])(
  "prefix evidence locates bad card %i, without rejecting the remaining members",
  async (position) => {
    const f = await fixture(4),
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
    expect(f.state().cards.every((c) => c.status === "awaiting_merge")).toBe(
      true,
    );
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
