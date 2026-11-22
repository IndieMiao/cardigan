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

test("quoted paths with spaces, URLs, scp addresses, hosts and IPs are redacted", () => {
  const cases: [string, string][] = [
    [
      "ENOENT: no such file or directory, realpath '/tmp/x/Team Project/private-module'",
      "ENOENT: no such file or directory, realpath '<路径>'",
    ],
    [
      "fatal: '/tmp/x/Studio's Team/private-module' does not appear to be a git repository",
      "fatal: '<路径>' does not appear to be a git repository",
    ],
    ['error: "/srv/a "quoted" dir/repo" missing', 'error: "<路径>" missing'],
    [
      "ssh: connect to host 192.168.1.23 port 22: Connection refused",
      "ssh: connect to host <主机> port 22: Connection refused",
    ],
    [
      "fatal: unable to access 'https://10.0.0.5/org/repo.git/': timeout",
      "fatal: unable to access '<路径>': timeout",
    ],
    [
      "fatal: could not read from ssh://user:secret@build-mac.lan:2222/srv/p.git",
      "fatal: could not read from <地址>",
    ],
    ["error: git@build-mac.lan:team/repo.git denied", "error: <地址> denied"],
    [
      "peer fe80::1 and 10.1.2.3 unreachable",
      "peer <地址> and <地址> unreachable",
    ],
    [
      "ssh: Could not resolve hostname build-mac.lan: Name not known",
      "ssh: Could not resolve hostname <主机>: Name not known",
    ],
    [
      "fatal: couldn't find remote ref 'refs/heads/integration/farm'",
      "fatal: couldn't find remote ref 'refs/heads/integration/farm'",
    ],
  ];
  for (const [input, expected] of cases)
    expect(redactMergeFailure(new Error(input))).toBe(expected);
});

test("a real file-system error keeps only its code and operation", async () => {
  const { realpath } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const missing = join(tmpdir(), "Studio's Team", "private-module");
  const error = await realpath(missing).catch((e: unknown) => e);
  expect(redactMergeFailure(error)).toBe("ENOENT（realpath）");
  expect(mergeFailureReason("C-9", error)).not.toContain("Team");
});

test("a missing local source with quotes and spaces never reaches the reason", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { CentralRepositoryService } = await import("@cardigan/git-service");
  const { CentralGitTransport } = await import("@cardigan/git-transport");
  const root = await mkdtemp(join(tmpdir(), "cg-redact-"));
  try {
    const dataDir = join(root, "data");
    const central = new CentralRepositoryService(
      new CentralGitTransport({ dataDir }),
      { dataDir },
    );
    for (const dir of ["Team Project", "Studio's Team", 'Quote "Team"']) {
      const error = await mergeStage("同步源仓库", () =>
        central.syncFromSource({
          project_id: "p",
          source_repo: join(root, dir, "private-module"),
          base_branch: "main",
        }),
      ).catch((e: unknown) => e);
      const reason = mergeFailureReason("C-9", error);
      expect(reason).toContain("「同步源仓库」");
      for (const leaked of ["Team", "private-module", root])
        expect(reason).not.toContain(leaked);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
