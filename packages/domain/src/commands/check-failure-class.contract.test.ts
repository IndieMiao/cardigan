import { expect, test } from "vitest";
import {
  type Actor,
  appendEvents,
  type CardId,
  classifyCheckFailure,
  type Event,
  FLAKY_AUTO_RERUN,
  failureModule,
  flakyEvidence,
  hasAutoRerun,
  latestMergeCheck,
  type MergeCheckView,
  mergeChain,
  passedOnOtherBase,
  recordMergeCheck,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human, value } from "./test-fixtures.js";

const system: Actor = { kind: "system", project_id: human.project_id };
const tree = "c".repeat(40),
  candidate = "b".repeat(40),
  base = "d".repeat(40),
  older = "e".repeat(40),
  peerMerge = "f".repeat(40);
const sys = (
  type: string,
  card_id: string,
  payload: Record<string, unknown>,
  seq: number,
): Event =>
  ({
    id: `0000000000000000000000${String(9000 + seq)}`,
    card_id,
    seq,
    type,
    actor: system,
    payload,
    created_at: "2026-01-01T00:00:00.000Z",
  }) as unknown as Event;

async function fixture(
  flow_version = 5,
  extra: (card: CardId) => Event[] = () => [],
) {
  const f = mergeFixture("confirm"),
    { completion, product } = await f.accept();
  const state = () => ({
    ...f.state,
    project_settings: { merge_gate_enabled: true },
    cards: f.state.cards.map((card) => ({ ...card, flow_version })),
    events: appendEvents(f.state.events, extra(f.card.id)),
  });
  const identity = {
    card_id: f.card.id,
    completion_id: completion.id,
    candidate_sha: candidate,
    tree_sha: tree,
    base_sha: base,
  };
  const start = (attempt_id: string) => {
    for (const status of ["queued", "running"] as const)
      f.commit(
        recordMergeCheck(
          state(),
          system,
          { ...identity, attempt_id, status },
          f.io,
        ),
      );
  };
  const failed = (
    attempt_id: string,
    checks: MergeCheckView["checks"],
    more: Record<string, unknown> = {},
  ) => ({
    ...identity,
    attempt_id,
    status: "failed" as const,
    summary: "检查 e2e 未通过（failed，退出码 1）\nTests 27 passed (27)",
    log_ref: `${attempt_id}.log`,
    checks,
    ...more,
  });
  return { f, state, identity, start, failed, completion, product };
}
const steps = (failing: string): MergeCheckView["checks"] =>
  ["install", "build", "test", "e2e"].map((name, i, all) => {
    const at = all.indexOf(failing);
    return {
      name,
      status: i < at ? "passed" : i === at ? "failed" : "not_run",
      exit_code: i < at ? 0 : i === at ? 1 : null,
    };
  });
const returned = (events: readonly Event[]) =>
  events.find((e) => e.type === "merge_changes_requested")?.payload as
    | { reason: string; failure_class: Record<string, unknown> }
    | undefined;

test("C-766: modules are the workspace package, else the top-level directory", () => {
  expect(failureModule("packages/host/src/a.test.ts")).toBe("packages/host");
  expect(failureModule("./apps/web/src/x.tsx")).toBe("apps/web");
  expect(failureModule("server/rules/water.gd")).toBe("server");
  expect(failureModule("README.md")).toBe("README.md");
});

test("C-766: each label has its own trigger and ties never guess", () => {
  const drift = [
    {
      card_id: "C-151" as CardId,
      merge_sha: peerMerge,
      paths: ["server/rules/water.gd"],
    },
  ];
  // baseline_drift: only a card merged since this card's base touched the module.
  expect(
    classifyCheckFailure({
      points: ["server/rules/harvest.gd"],
      own: ["tests/e2e/harvest.test.ts"],
      drift,
    }),
  ).toMatchObject({
    label: "baseline_drift",
    cards: ["C-151"],
    commits: [peerMerge],
  });
  // baseline_drift: the same deliveries passed on an older base.
  expect(
    classifyCheckFailure({
      points: ["tests/e2e/harvest.test.ts"],
      own: ["tests/e2e/harvest.test.ts"],
      drift,
      passed_base: older,
      base,
    }),
  ).toMatchObject({
    label: "baseline_drift",
    cards: ["C-151"],
    basis: expect.stringContaining(`基线 ${older.slice(0, 8)} 上通过`),
  });
  // genuine: the failing module is only in this card's own changes.
  expect(
    classifyCheckFailure({
      points: ["packages/host/src/a.test.ts"],
      own: ["packages/host/src/a.ts"],
      drift,
    }),
  ).toMatchObject({ label: "genuine" });
  // unknown: nothing located, or no side touched the module.
  expect(
    classifyCheckFailure({ points: [], own: ["a/b.ts"], drift }),
  ).toMatchObject({ label: "unknown", basis: "日志未定位到失败文件" });
  expect(
    classifyCheckFailure({ points: ["lib/x.ts"], own: ["a/b.ts"], drift }),
  ).toMatchObject({ label: "unknown" });
  // Both touched the module: the exact file decides, else unknown with both.
  const both = [
    {
      card_id: "C-7" as CardId,
      merge_sha: peerMerge,
      paths: ["packages/host/src/b.ts"],
    },
  ];
  expect(
    classifyCheckFailure({
      points: ["packages/host/src/a.ts"],
      own: ["packages/host/src/a.ts"],
      drift: both,
    }),
  ).toMatchObject({ label: "genuine" });
  expect(
    classifyCheckFailure({
      points: ["packages/host/src/b.ts"],
      own: ["packages/host/src/a.ts"],
      drift: both,
    }),
  ).toMatchObject({ label: "baseline_drift", cards: ["C-7"] });
  expect(
    classifyCheckFailure({
      points: ["packages/host/src/c.ts"],
      own: ["packages/host/src/a.ts"],
      drift: both,
    }),
  ).toMatchObject({ label: "unknown", cards: ["C-7"] });
});

test("C-766: the merge chain follows recorded merges and stops at unknown commits", async () => {
  const events = appendEvents(
    [],
    [
      sys(
        "card_merged",
        "C-1",
        {
          result: {
            kind: "merged",
            merge_sha: older,
            previous_sha: "1".repeat(40),
          },
        },
        1,
      ),
      sys(
        "card_merged",
        "C-2",
        { result: { kind: "merged", merge_sha: base, previous_sha: older } },
        2,
      ),
      sys(
        "card_merged",
        "C-3",
        {
          result: {
            kind: "merged",
            merge_sha: candidate,
            previous_sha: candidate,
            noop: true,
          },
        },
        3,
      ),
    ],
  );
  expect(mergeChain(events, base).map((m) => m.card_id)).toEqual([
    "C-2",
    "C-1",
  ]);
  expect(mergeChain(events, base, 1).map((m) => m.card_id)).toEqual(["C-2"]);
  expect(mergeChain(events, candidate)).toEqual([]);
});

test("C-766: host classification reaches the return event and the fix prompt reason", async () => {
  const { f, state, start, failed } = await fixture(5, () => [
    sys(
      "card_merged",
      "C-151",
      { result: { kind: "merged", merge_sha: peerMerge, previous_sha: older } },
      1,
    ),
  ]);
  start("attempt-1");
  const drift = {
    label: "baseline_drift",
    basis: "失败位置 server/rules/harvest.gd；期间合入的 C-151 改过这些模块",
    cards: ["C-151"],
    commits: [peerMerge],
  };
  const effect = value(
    recordMergeCheck(
      state(),
      system,
      failed("attempt-1", steps("e2e"), { failure_class: drift }),
      f.io,
    ),
  );
  expect(effect.events.some((e) => e.type === "merge_check_requeued")).toBe(
    false,
  );
  expect(effect.events[0]?.payload).toMatchObject({ failure_class: drift });
  const payload = returned(effect.events);
  expect(payload?.failure_class).toEqual(drift);
  expect(payload?.reason).toContain("Tests 27 passed (27)");
  expect(payload?.reason).toContain(
    "失败分类：baseline_drift（基线漂移）：失败位置 server/rules/harvest.gd",
  );
});

test.each([
  ["flaky from the host", { label: "flaky", basis: "x" }],
  [
    "an unmerged drift card",
    {
      label: "baseline_drift",
      basis: "x",
      cards: ["C-404"],
      commits: [peerMerge],
    },
  ],
  ["drift without cards", { label: "baseline_drift", basis: "x" }],
  ["genuine with cards", { label: "genuine", basis: "x", cards: ["C-151"] }],
  ["a control character", { label: "unknown", basis: "a\nb" }],
  ["an unknown key", { label: "unknown", basis: "x", passed: true }],
  ["a leaked token", { label: "unknown", basis: "token=abcdef" }],
])(
  "C-766: rejects host classification with %s",
  async (_name, failure_class) => {
    const { f, state, start, failed } = await fixture(5, () => [
      sys(
        "card_merged",
        "C-151",
        {
          result: { kind: "merged", merge_sha: peerMerge, previous_sha: older },
        },
        1,
      ),
    ]);
    start("attempt-1");
    expect(
      recordMergeCheck(
        state(),
        system,
        failed("attempt-1", steps("e2e"), { failure_class }),
        f.io,
      ),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
  },
);

test("C-766: classification is rejected on a passed result and cannot change its outcome", async () => {
  const { f, state, start, identity } = await fixture();
  start("attempt-1");
  expect(
    recordMergeCheck(
      state(),
      system,
      {
        ...identity,
        attempt_id: "attempt-1",
        status: "passed",
        summary: "ok",
        log_ref: "attempt-1.log",
        checks: [{ name: "test", status: "passed", exit_code: 0 }],
        failure_class: { label: "genuine", basis: "x" },
      } as never,
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
});

test("C-766: a pre-test failure reruns once; the second failure returns with the rerun result", async () => {
  const { f, state, start, failed, identity } = await fixture();
  start("attempt-1");
  const first = value(
    recordMergeCheck(
      state(),
      system,
      failed("attempt-1", steps("install")),
      f.io,
    ),
  );
  f.commit({ ok: true, value: first });
  expect(first.events.map((e) => e.type)).toEqual([
    "merge_check_finished",
    "merge_check_requeued",
  ]);
  expect(first.events[0]?.payload).toMatchObject({
    auto_rerun: true,
    failure_class: {
      label: "flaky",
      basis: "测试开始前的步骤 install 失败，自动重跑一次",
      rerun: { attempt_id: "attempt-1", result: "queued" },
    },
  });
  expect(first.events[1]?.payload).toMatchObject({ via: FLAKY_AUTO_RERUN });
  expect(first.events[1]?.payload).not.toHaveProperty("failure_class");
  expect(hasAutoRerun(state().events, f.card.id, identity.completion_id)).toBe(
    true,
  );
  expect(returned(first.events)).toBeUndefined();
  start("attempt-2");
  const second = value(
    recordMergeCheck(
      state(),
      system,
      failed("attempt-2", steps("install"), {
        failure_class: { label: "unknown", basis: "日志未定位到失败文件" },
      }),
      f.io,
    ),
  );
  // Terminates: no second rerun, the author gets a non-flaky label.
  expect(second.events.some((e) => e.type === "merge_check_requeued")).toBe(
    false,
  );
  expect(returned(second.events)?.failure_class).toEqual({
    label: "unknown",
    basis:
      "已按偶发自动重跑一次（首次 attempt-1），重跑仍失败；日志未定位到失败文件",
    rerun: { attempt_id: "attempt-1", result: "failed" },
  });
  expect(returned(second.events)?.reason).toContain("重跑仍失败");
  f.commit({ ok: true, value: second });
  expect(f.state.cards[0]?.status).toBe("in_progress");
});

test("C-766: a tree that passed an author precheck reruns once as flaky", async () => {
  const { f, state, start, failed, product } = await fixture(5, (card) => [
    sys(
      "precheck_finished",
      card,
      {
        attempt_id: "pre-1",
        card_id: card,
        head_sha: product.subject.value,
        status: "passed",
        tree_sha: tree,
        base_sha: base,
        assignment_id: "A-1",
        work_item_id: "W-1",
        branch: "b",
        machine_id: "m",
      },
      1,
    ),
  ]);
  expect(
    flakyEvidence(state().events, f.card.id, {
      status: "failed",
      tree_sha: tree,
      checks: steps("e2e"),
    }),
  ).toBe("同一代码树此前的作者预检已通过");
  start("attempt-1");
  const effect = value(
    recordMergeCheck(state(), system, failed("attempt-1", steps("e2e")), f.io),
  );
  expect(effect.events[1]?.payload).toMatchObject({ via: FLAKY_AUTO_RERUN });
  expect(returned(effect.events)).toBeUndefined();
});

test("C-766: no flaky evidence returns at once; flow 1 never reruns or returns", async () => {
  const { f, state, start, failed } = await fixture();
  start("attempt-1");
  const effect = value(
    recordMergeCheck(
      state(),
      system,
      failed("attempt-1", steps("test"), {
        failure_class: { label: "genuine", basis: "失败模块在本卡改动范围内" },
      }),
      f.io,
    ),
  );
  expect(effect.events.some((e) => e.type === "merge_check_requeued")).toBe(
    false,
  );
  expect(returned(effect.events)?.failure_class).toEqual({
    label: "genuine",
    basis: "失败模块在本卡改动范围内",
  });
  const legacy = await fixture(1);
  legacy.start("attempt-1");
  const old = value(
    recordMergeCheck(
      legacy.state(),
      system,
      legacy.failed("attempt-1", steps("install")),
      legacy.f.io,
    ),
  );
  expect(old.events.map((e) => e.type)).toEqual(["merge_check_finished"]);
});

test("C-766: the failed check view keeps its classification", async () => {
  const { f, state, start, failed, identity } = await fixture(5);
  start("attempt-1");
  f.commit(
    recordMergeCheck(
      state(),
      system,
      failed("attempt-1", steps("test"), {
        failure_class: { label: "genuine", basis: "x" },
      }),
      f.io,
    ),
  );
  expect(
    latestMergeCheck(state().events, f.card.id, identity.completion_id)
      ?.failure_class,
  ).toMatchObject({
    label: "genuine",
  });
});

test("C-766: an older passing base of the same deliveries is found from checks or prechecks", async () => {
  const { f, state, completion, product } = await fixture(5, (card) => [
    sys(
      "precheck_finished",
      card,
      {
        attempt_id: "pre-1",
        card_id: card,
        head_sha: product.subject.value,
        status: "passed",
        tree_sha: "9".repeat(40),
        base_sha: older,
        assignment_id: "A-1",
        work_item_id: "W-1",
        branch: "b",
        machine_id: "m",
      },
      1,
    ),
  ]);
  expect(
    passedOnOtherBase(
      state().events,
      f.card.id,
      completion.id,
      [product.subject.value],
      base,
    ),
  ).toBe(older);
  expect(
    passedOnOtherBase(
      state().events,
      f.card.id,
      completion.id,
      [product.subject.value],
      older,
    ),
  ).toBeUndefined();
});
