import { RepositoryLockTimeoutError } from "@cardigan/git-service";
import { expect, test, vi } from "vitest";
import {
  describePreparationFailure,
  PreparationError,
  redactFailureLine,
  withPreparationRetry,
} from "./wake-preparation.js";

const gitError = (stderr: string, code = 128) =>
  Object.assign(
    new Error(
      `Command failed: git -c safe.directory=/x -C /data/agent/repos/p fetch\n${stderr}`,
    ),
    { code, stderr },
  );

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
