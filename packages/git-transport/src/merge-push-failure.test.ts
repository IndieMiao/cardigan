import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CentralGitTransport } from "./central.js";

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: exec }) };
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  exec.mockReset();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

test.each([
  { code: 128, stderr: "Permission denied (publickey)", reason: "auth" },
  { code: 255, stderr: "Host key verification failed", reason: "auth" },
  { code: 128, stderr: "Could not resolve hostname", reason: "network" },
  { code: 1, stderr: "[rejected] non-fast-forward", reason: "rejected" },
  { code: 128, stderr: "unclassified", reason: "other" },
  { code: "ENOENT", stderr: "unclassified", reason: "other" },
  { code: null, stderr: "Permission denied", killed: true, reason: "network" },
])(
  "push failure preserves only numeric status and fixed category: $reason/$code",
  async ({ code, stderr, reason, ...extra }) => {
    const root = await mkdtemp(join(tmpdir(), "cg-push-failure-"));
    roots.push(root);
    const transport = new CentralGitTransport({ dataDir: root });
    await mkdir(transport.root, { mode: 0o700 });
    const repository = join(transport.root, "fixture.git");
    await mkdir(repository, { mode: 0o700 });
    vi.spyOn(transport, "objectType").mockResolvedValue("commit");
    const secret =
      "synthetic-private-key https://user:fixture-password@example.invalid/repo";
    exec.mockRejectedValueOnce(
      Object.assign(new Error(secret), {
        code,
        stderr: `${stderr}\n${secret}`,
        stdout: secret,
        ...extra,
      }),
    );
    const result = await transport.pushMergedCommit(repository, {
      sha: "a".repeat(40),
      remote: "git@example.invalid:team/repo.git",
      branch: "main",
      keyFile: "/fixture/key",
      knownHostsFile: "/fixture/known_hosts",
    });
    expect(result).toEqual({
      status: "failed",
      reason,
      ...(typeof code === "number" ? { exit_code: code } : {}),
    });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(secret);
  },
);
