import { expect, test } from "vitest";
import {
  MergeStageError,
  mergeFailureReason,
  mergeStage,
  redactMergeFailure,
} from "./merge-failure.js";

test("a merge failure names its step and redacts paths, credentials and argv", async () => {
  const error = await mergeStage("同步源仓库", () => {
    throw new Error(
      "Command failed: git -c http.extraHeader=Authorization: Bearer ghp_abcdefghijklmnop fetch /srv/data/central/p.git\nfatal: could not read from 'ssh://user:secret@example.invalid/repo' at /home/someone/repo/.git",
    );
  }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MergeStageError);
  const reason = mergeFailureReason("C-18", error);
  expect(reason).toMatch(/^合并 C-18 在「同步源仓库」环节失败：fatal: /u);
  for (const leaked of [
    "/srv/data",
    "/home/someone",
    "secret",
    "ghp_abcdefghijklmnop",
    "Command failed",
    "extraHeader",
  ])
    expect(reason).not.toContain(leaked);
  expect(reason).toContain("<路径>");
});

test("the innermost step wins; branch names and untagged errors stay readable", async () => {
  const inner = await mergeStage("发布合并", () =>
    mergeStage("准备合并候选", () => {
      throw new Error("Central baseline branch is missing");
    }),
  ).catch((e: unknown) => e);
  expect(mergeFailureReason("C-1", inner)).toBe(
    "合并 C-1 在「准备合并候选」环节失败：Central baseline branch is missing。未发布未经检查的代码",
  );
  expect(
    redactMergeFailure(
      new Error("couldn't find remote ref refs/heads/integration/dynamicfarm"),
    ),
  ).toBe("couldn't find remote ref refs/heads/integration/dynamicfarm");
  expect(mergeFailureReason("C-2", "boom", "检查或结果记录")).toContain(
    "「检查或结果记录」",
  );
  expect(redactMergeFailure(new Error(`x${"y".repeat(500)}`))).toHaveLength(
    200,
  );
  expect(redactMergeFailure(undefined)).toBe("未知错误");
});
