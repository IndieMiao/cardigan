import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CentralGitTransport } from "./central.js";

const fake = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: Object.assign(() => {}, {
    [Symbol.for("nodejs.util.promisify.custom")]: fake.exec,
  }),
}));

import { classifyCandidatePushFailure } from "./candidate-push.js";

const input = {
  repo: "fixture/project",
  sha: "a".repeat(40),
  ref: "refs/heads/ci/C-1/D-1/attempt-1",
  token: `ghs_${"a".repeat(36)}`,
};
let root: string;
let repository: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "candidate-failure-"));
  const central = join(root, "central");
  repository = join(central, "fixture.git");
  await mkdir(central, { mode: 0o700 });
  await mkdir(repository, { mode: 0o700 });
  fake.exec.mockReset();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
/** Git failure as execFile reports it: raw output stays inside the transport. */
function gitFailure(fields: Record<string, unknown>) {
  return Object.assign(new Error(`git failed ${input.token}`), fields);
}
function pushWith(error: unknown, options = {}) {
  fake.exec.mockImplementation(async (_file: string, args: string[]) => {
    if (args.includes("cat-file")) return { stdout: "commit\n", stderr: "" };
    throw error;
  });
  return new CentralGitTransport({ dataDir: root, ...options });
}

test.each([
  [
    "remote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/fixture/project.git/'",
    "auth",
  ],
  [
    "remote: Permission to fixture/project.git denied to app[bot].\nfatal: unable to access 'https://github.com/fixture/project.git/': The requested URL returned error: 403",
    "auth",
  ],
  [
    " ! [remote rejected] aaaa -> ci/C-1/D-1/attempt-1 (protected branch hook declined)",
    "rejected",
  ],
  [
    "fatal: unable to access 'https://github.com/fixture/project.git/': The requested URL returned error: 503",
    "github_error",
  ],
  [
    "fatal: unable to access 'https://github.com/fixture/project.git/': Could not resolve host: github.com",
    "network",
  ],
  [
    "error: RPC failed; curl 56 Recv failure: Connection reset by peer\nfatal: the remote end hung up unexpectedly",
    "network",
  ],
  [
    "fatal: unable to access 'https://github.com/fixture/project.git/': Failed to connect to github.com port 443 after 21 ms",
    "network",
  ],
  ["fatal: something new", "other"],
] as const)(
  "C-758: Git HTTPS output %# is classified as %s",
  (output, reason) => {
    expect(classifyCandidatePushFailure(output)).toBe(reason);
  },
);

test("C-758: GitHub's answer is classified from in-memory output and the exit code alone leaves the transport", async () => {
  const transport = pushWith(
    gitFailure({
      code: 128,
      stdout: "",
      stderr: `fatal: Authentication failed for 'https://x-access-token:${input.token}@github.com/'`,
    }),
  );
  const result = await transport.pushCandidateCommit(repository, input);
  expect(result).toEqual({ status: "failed", reason: "auth", exit_code: 128 });
  expect(JSON.stringify(result)).not.toContain(input.token);
});

test("C-758: the host transfer budget is a push timeout, not a network failure", async () => {
  const transport = pushWith(
    gitFailure({ killed: true, signal: "SIGKILL", code: null }),
    { transferTimeoutMs: 1000 },
  );
  expect(await transport.pushCandidateCommit(repository, input)).toEqual({
    status: "failed",
    reason: "timeout",
  });
});

test.each(["signal", "AbortError"] as const)(
  "C-758: a local abort (%s) is a cancellation",
  async (mode) => {
    const abort = new AbortController();
    const error =
      mode === "AbortError"
        ? gitFailure({ name: "AbortError", code: "ABORT_ERR" })
        : gitFailure({ code: 128, stderr: "Connection reset" });
    fake.exec.mockImplementation(async (_file: string, args: string[]) => {
      if (args.includes("cat-file")) return { stdout: "commit\n", stderr: "" };
      if (mode === "signal") abort.abort();
      throw error;
    });
    const transport = new CentralGitTransport({ dataDir: root });
    expect(
      await transport.pushCandidateCommit(repository, {
        ...input,
        signal: abort.signal,
      }),
    ).toMatchObject({ status: "failed", reason: "cancelled" });
  },
);

test("C-758: a failure before Git transport is local and never starts a push", async () => {
  fake.exec.mockImplementation(async (_file: string, args: string[]) => {
    if (args.includes("cat-file")) return { stdout: "blob\n", stderr: "" };
    throw new Error("push must not run");
  });
  const transport = new CentralGitTransport({ dataDir: root });
  expect(await transport.pushCandidateCommit(repository, input)).toEqual({
    status: "failed",
    reason: "local",
  });
  expect(
    await transport.pushCandidateCommit(join(root, "elsewhere.git"), input),
  ).toEqual({ status: "failed", reason: "local" });
  expect(
    fake.exec.mock.calls.some((call) => (call[1] as string[]).includes("push")),
  ).toBe(false);
});
