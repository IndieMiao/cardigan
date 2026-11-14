import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CentralRepositoryService,
  RepositoryLockTimeoutError,
} from "@cardigan/git-service";
import { CentralGitTransport } from "@cardigan/git-transport";
import { agentCommandError, processClient } from "@cardigan/runtime-herdr";
import { expect, test, vi } from "vitest";
import {
  describePreparationFailure,
  PreparationError,
  preparationExecutionExited,
  redactFailureLine,
  redactSecrets,
  withPreparationRetry,
} from "./wake-preparation.js";

const exec = promisify(execFile);

const gitError = (stderr: string, code = 128) =>
  Object.assign(
    new Error(
      `Command failed: git -c safe.directory=/x -C /data/agent/repos/p fetch\n${stderr}`,
    ),
    { code, stderr },
  );

test("one-run recovery requires exit proof and refuses permission messages even when they mention networking", () => {
  expect(
    preparationExecutionExited(
      Object.assign(new Error("Git config timed out after 30ms"), {
        code: "runtime_timeout",
      }),
    ),
  ).toBe(false);
  expect(
    preparationExecutionExited(
      Object.assign(new Error("Git config timed out after 30ms"), {
        executionExited: true,
      }),
    ),
  ).toBe(true);
  expect(
    describePreparationFailure(
      gitError("unable to access repository: Permission denied"),
    ),
  ).toMatchObject({ retryable: false, category: "prepare_failed" });
});

test.each([
  [
    gitError(
      "fatal: Unable to create '/data/agent/repos/p/.git/index.lock': File exists.",
    ),
    "git_lock_conflict",
    true,
  ],
  [
    gitError("error: cannot lock ref 'refs/remotes/origin/main': is at abc"),
    "git_lock_conflict",
    true,
  ],
  [
    gitError("fatal: unable to access 'https://example.invalid/': timeout"),
    "git_network",
    true,
  ],
  [gitError("fatal: not a git repository", 128), "git_failed", false],
  [new RepositoryLockTimeoutError(30_000), "repository_lock_timeout", true],
  [
    new Error("Git fetch timed out after 1800000ms; configure X"),
    "git_timeout",
    false,
  ],
  [
    Object.assign(new Error("runtime_unavailable: no agent"), {
      code: "runtime_unavailable",
    }),
    "runtime_failed",
    false,
  ],
  [
    new Error("Project p has no registered repository"),
    "prepare_failed",
    false,
  ],
] as const)("classifies %#", (error, category, retryable) => {
  expect(describePreparationFailure(error)).toMatchObject({
    category,
    retryable,
  });
});

test("keeps the exit code and the first stderr line, never the argv line", () => {
  expect(
    describePreparationFailure(
      gitError("fatal: early EOF\nfatal: index-pack failed", 128),
    ),
  ).toEqual({
    category: "git_network",
    exit_code: 128,
    message: "fatal: early EOF",
    retryable: true,
  });
});

test("redacts credentials but keeps paths", () => {
  const line = redactFailureLine(
    "fatal: could not read from https://bot:hunter2@git.example/x /data/repos/p token=abc123 Bearer xyz ghp_ABCDEFGHIJKLMNOP",
  );
  expect(line).toContain("/data/repos/p");
  for (const secret of ["hunter2", "abc123", "xyz", "ghp_ABCDEFGHIJKLMNOP"])
    expect(line).not.toContain(secret);
  expect(redactFailureLine("x".repeat(1000))).toHaveLength(300);
});

test("retries transient failures 1, 2 and 4 seconds apart, then reports the last failure", async () => {
  const sleep = vi.fn(async () => undefined);
  const prepare = vi.fn(async () => {
    throw gitError("fatal: cannot lock ref 'refs/remotes/origin/main'");
  });
  const failure = await withPreparationRetry(prepare, { sleep }).catch(
    (error: unknown) => error,
  );
  expect(prepare).toHaveBeenCalledTimes(4);
  expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000]);
  expect(failure).toBeInstanceOf(PreparationError);
  expect(failure).toMatchObject({
    attempts: 4,
    code: "git_lock_conflict",
    failure: { exit_code: 128 },
  });
});

test("does not retry a permanent failure", async () => {
  const sleep = vi.fn(async () => undefined);
  const prepare = vi.fn(async () => {
    throw gitError("fatal: not a git repository");
  });
  await expect(withPreparationRetry(prepare, { sleep })).rejects.toMatchObject({
    attempts: 1,
    code: "git_failed",
  });
  expect(sleep).not.toHaveBeenCalled();
});

test("returns the first successful attempt", async () => {
  const prepare = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(new RepositoryLockTimeoutError(10))
    .mockResolvedValueOnce("ready");
  await expect(
    withPreparationRetry(prepare, { sleep: async () => undefined }),
  ).resolves.toBe("ready");
  expect(prepare).toHaveBeenCalledTimes(2);
});

test.each([
  [
    "fatal: unable to access https://example.invalid/repo?access_token=FAKE_REVIEW_SECRET",
    "access_token=***",
  ],
  ['fatal: {"token":"FAKE_REVIEW_SECRET"}', '"token":***'],
  ['fatal: password="FAKE FIRST SECOND" rest', "password=*** rest"],
  ["fatal: password='FAKE FIRST' rest", "password=*** rest"],
  [
    "error: http.extraHeader=X-Custom:FAKE_REVIEW_SECRET rejected",
    "http.extraHeader=*** rejected",
  ],
  ["Authorization: Bearer FAKE_REVIEW_SECRET", "Authorization: ***"],
  ["remote: x-api-key: FAKE_REVIEW_SECRET", "x-api-key: ***"],
  ["fatal: https://bot:FAKE_REVIEW_SECRET@git.example/x", "https://***@"],
])("redacts %s", (input, kept) => {
  const line = redactFailureLine(input);
  expect(line).not.toContain("FAKE");
  expect(line).not.toContain("SECOND");
  expect(line).toContain(kept);
});

test("redacts values of secret-looking environment variables", () => {
  expect(
    redactSecrets("fatal: bad header abcdef123456", {
      CARDIGAN_PUSH_TOKEN: "abcdef123456",
    }),
  ).toBe("fatal: bad header ***");
});

test("never falls back to the argv line when Git printed nothing", () => {
  const failure = describePreparationFailure(
    Object.assign(
      new Error(
        "Command failed: git -c http.extraHeader=X-Custom:FAKE_REVIEW_SECRET fetch",
      ),
      { code: 128, stderr: "" },
    ),
  );
  expect(failure).toEqual({
    category: "git_failed",
    exit_code: 128,
    message: "git exited with 128 without diagnostic output",
    retryable: false,
  });
});

test("an hc client failure keeps its category but cannot authorize a remote Git retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cardigan-hc-"));
  try {
    const hc = join(dir, "hc");
    await writeFile(
      hc,
      `#!/bin/sh\necho "fatal: cannot lock ref 'refs/remotes/origin/main': File exists" >&2\nexit 128\n`,
      { mode: 0o700 },
    );
    const client = processClient(hc, { PATH: "/usr/bin:/bin" }, dir, 5_000);
    // The same conversion worktreeProvider applies to a failed captureAgent.
    const run = async () => {
      try {
        return await client.exec(["exec", "--", "git", "fetch"]);
      } catch (error) {
        const e = error as { code: never; message: string; detail?: never };
        throw agentCommandError({
          code: e.code,
          message: e.message,
          ...(e.detail ? { detail: e.detail } : {}),
        });
      }
    };
    const sleep = vi.fn(async () => undefined);
    await expect(withPreparationRetry(run, { sleep })).rejects.toMatchObject({
      attempts: 1,
      failure: {
        category: "git_lock_conflict",
        exit_code: 128,
        message:
          "fatal: cannot lock ref 'refs/remotes/origin/main': File exists",
      },
    });
    expect(sleep).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a central Git failure keeps its exit status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cardigan-central-"));
  try {
    const dataDir = join(dir, "data"),
      source = join(dir, "source");
    await mkdir(dataDir, { mode: 0o700 });
    await exec("git", ["init", "-q", "-b", "main", source]);
    await writeFile(join(source, "README.md"), "x\n");
    await exec("git", ["-C", source, "add", "README.md"]);
    await exec("git", [
      "-C",
      source,
      "-c",
      "user.name=F",
      "-c",
      "user.email=f@example.invalid",
      "commit",
      "-qm",
      "init",
    ]);
    const transport = new CentralGitTransport({ dataDir });
    const repository = await new CentralRepositoryService(transport, {
      dataDir,
    }).ensureCentral({
      project_id: "p",
      source_repo: source,
      base_branch: "main",
    });
    const error = await transport
      .fetchRefs(repository, source, ["refs/heads/missing:refs/x"])
      .catch((e: unknown) => e);
    expect(describePreparationFailure(error)).toMatchObject({
      category: "git_failed",
      exit_code: 128,
      message: expect.stringContaining("couldn't find remote ref"),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.each([
  "fatal: 无法创建 '/data/agent/repos/p/.git/index.lock'：文件已存在。",
  "error: 无法锁定引用 'refs/remotes/origin/main'",
])(
  "an Agent-side zh_CN Git lock message is still a lock conflict: %s",
  (stderr) => {
    expect(
      describePreparationFailure(
        Object.assign(new Error("x"), { code: 128, stderr }),
      ),
    ).toMatchObject({ category: "git_lock_conflict", retryable: true });
  },
);
