import { expect, test } from "vitest";
import {
  type Actor,
  beginMergePush,
  type CommandState,
  foreignMergePushCommits,
  mergePushRoute,
  pmMergeBlockers,
  recordMergeResult,
} from "../index.js";
import { mergeFixture } from "./merge/test-fixtures.js";
import { human } from "./test-fixtures.js";

/** C-589: cards of one project merge into their own baseline branches. */
const system: Actor = { kind: "system", project_id: human.project_id };
const main = { target: "a".repeat(64), branch: "main", base_branch: "main" };
const farm = {
  target: "b".repeat(64),
  branch: "integration/farm",
  base_branch: "integration/farm",
};

async function merged(
  base_branch: string,
  routes: CommandState["project_settings"] = {
    merge_push: [main, farm],
  },
) {
  const f = mergeFixture("auto", 3);
  const { completion } = await f.accept();
  const state = (): CommandState => ({
    ...f.state,
    project_settings: routes,
    cards: f.state.cards.map((c) =>
      c.id === f.card.id ? { ...c, base_branch } : c,
    ),
  });
  f.commit(
    recordMergeResult(
      state(),
      system,
      {
        card_id: f.card.id,
        completion_id: completion.id,
        result: {
          kind: "merged",
          merge_sha: "c".repeat(40),
          previous_sha: "d".repeat(40),
        },
      },
      f.io,
    ),
  );
  const queued = f.state.events.filter((e) => e.type === "merge_push_queued");
  return { f, state, queued };
}

test("a merge queues only the push route of the card's own baseline branch", async () => {
  const onMain = await merged("main");
  expect(onMain.queued.map((e) => e.payload)).toEqual([
    expect.objectContaining({
      target: main.target,
      branch: "main",
      base_branch: "main",
    }),
  ]);
  const onFarm = await merged("integration/farm");
  expect(onFarm.queued.map((e) => e.payload)).toEqual([
    expect.objectContaining({
      target: farm.target,
      branch: "integration/farm",
      base_branch: "integration/farm",
    }),
  ]);
  // The farm queue is independent: the main route has nothing to push.
  expect(
    beginMergePush(
      onFarm.state(),
      system,
      { target: main.target, branch: "main", attempt_id: "main-1" },
      onFarm.f.io,
    ),
  ).toMatchObject({ ok: true, value: { data: undefined } });
  expect(
    beginMergePush(
      onFarm.state(),
      system,
      {
        target: farm.target,
        branch: "integration/farm",
        attempt_id: "farm-1",
      },
      onFarm.f.io,
    ),
  ).toMatchObject({
    ok: true,
    value: { data: { target: farm.target, sha: "c".repeat(40) } },
  });
});

test("a branch without a push route merges centrally and is never pushed", async () => {
  const { queued, state, f } = await merged("integration/other");
  expect(queued).toEqual([]);
  expect(mergePushRoute(state(), "integration/other")).toBeUndefined();
  expect(mergePushRoute(state(), "main")).toEqual({
    target: main.target,
    branch: "main",
  });
  // An unconfigured destination cannot be started for any branch.
  expect(
    beginMergePush(
      state(),
      system,
      { target: "e".repeat(64), branch: "integration/other", attempt_id: "x" },
      f.io,
    ),
  ).toMatchObject({ ok: false, error: { code: "illegal_transition" } });
  expect((await merged("main", {})).queued).toEqual([]);
});

test("a missing check result says whether the gate is unconfigured or the candidate failed", async () => {
  const f = mergeFixture("confirm", 3);
  const { completion } = await f.accept();
  const q = f.state.decisions.find((q) => q.trigger === "merge_confirmation");
  if (!q) throw new Error("Missing confirmation");
  expect(pmMergeBlockers(f.state, q)).toContain(
    "项目未配置合并闸门，须交人确认合并",
  );
  const gated = (): CommandState => ({
    ...f.state,
    project_settings: { merge_gate_enabled: true },
  });
  expect(pmMergeBlockers(gated(), q)).toContain(
    "合并闸门检查尚未排队或尚无结果",
  );
  const reason =
    "合并 C-1 在「准备合并候选」环节失败：Central baseline branch is missing。未发布未经检查的代码";
  f.commit(
    recordMergeResult(
      gated(),
      system,
      {
        card_id: f.card.id,
        completion_id: completion.id,
        result: { kind: "failed", reason },
      },
      f.io,
    ),
  );
  const blockers = pmMergeBlockers(gated(), q);
  expect(blockers).toContain(`合并候选准备失败，检查未排队：${reason}`);
  expect(blockers.join("\n")).not.toContain("未配置合并闸门");
});

test("rebinding a remote branch to another baseline never inherits the old queue or trusted boundary", async () => {
  const onMain = await merged("main", { merge_push: [main] });
  expect(onMain.queued).toHaveLength(1);
  // The same remote target now publishes integration/farm instead of main.
  const rebound = { ...main, base_branch: "integration/farm" };
  const state = (): CommandState => ({
    ...onMain.state(),
    project_settings: { merge_push: [rebound] },
  });
  expect(
    beginMergePush(
      state(),
      system,
      {
        target: main.target,
        branch: "main",
        base_branch: "integration/farm",
        attempt_id: "rebound-1",
      },
      onMain.f.io,
    ),
  ).toMatchObject({ ok: true, value: { data: undefined } });
  // The original binding still sees its queued merge.
  expect(
    beginMergePush(
      onMain.state(),
      system,
      { target: main.target, branch: "main", attempt_id: "main-1" },
      onMain.f.io,
    ),
  ).toMatchObject({
    ok: true,
    value: { data: { base_branch: "main", sha: "c".repeat(40) } },
  });
});

test("foreign-commit evidence counts only merges into the route's own branch", async () => {
  const onFarm = await merged("integration/farm");
  const chain = [
    {
      sha: "c".repeat(40),
      parent: "d".repeat(40),
      author: "Fixture",
      committer: "Fixture",
      subject: "farm merge",
    },
  ];
  expect(
    foreignMergePushCommits(
      onFarm.state(),
      main.target,
      "d".repeat(40),
      chain,
      "main",
    ).foreign.map((c) => c.sha),
  ).toEqual(["c".repeat(40)]);
  expect(
    foreignMergePushCommits(
      onFarm.state(),
      farm.target,
      "d".repeat(40),
      chain,
      "integration/farm",
    ).foreign,
  ).toEqual([]);
});
