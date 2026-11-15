import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { centralFixture, commit, git } from "../test-support/git.js";
import { classifyPushFailure, mergePushCommand } from "./merge-push.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0)) await close();
});
test("push is a literal fast-forward refspec with isolated SSH and an exact environment whitelist", () => {
  vi.stubEnv("SSH_AUTH_SOCK", "/host/agent");
  vi.stubEnv("PROVIDER_KEY", "sensitive");
  vi.stubEnv("GIT_SSH_COMMAND", "host-hook");
  const p = mergePushCommand("/fixture/center.git", {
    sha: "a".repeat(40),
    remote: "git@example.invalid:team/repo.git",
    branch: "main",
    keyFile: "/private/key with 'quote",
    knownHostsFile: "/private/known",
  });
  expect(p.args.slice(-4)).toEqual([
    "--porcelain",
    "--",
    "git@example.invalid:team/repo.git",
    `${"a".repeat(40)}:refs/heads/main`,
  ]);
  expect(p.args.some((a) => a.startsWith("+") || a.startsWith("--force"))).toBe(
    false,
  );
  for (const value of [
    "'-F' '/dev/null'",
    "IdentitiesOnly=yes",
    "IdentityAgent=none",
    "StrictHostKeyChecking=yes",
    'UserKnownHostsFile="/private/known"',
    "'\\''",
  ])
    expect(p.env.GIT_SSH_COMMAND).toContain(value);
  expect(Object.keys(p.env).sort()).toEqual(
    [
      "PATH",
      "LC_ALL",
      "LANG",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_GLOBAL",
      "GIT_TERMINAL_PROMPT",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_SSH_COMMAND",
      "GIT_SSH_VARIANT",
    ].sort(),
  );
  expect(JSON.stringify(p)).not.toContain("sensitive");
  expect(p.env.SSH_AUTH_SOCK).toBeUndefined();
});
test("real local push succeeds, repeats harmlessly and refuses a diverged remote without exposing diagnostics", async () => {
  const f = await centralFixture();
  cleanup.push(f.close);
  const center = await f.central.ensureCentral(f.project),
    remote = join(f.root, "remote.git");
  await git(f.root, "init", "--bare", remote);
  const input = {
    sha: f.initial,
    remote: pathToFileURL(remote).href,
    branch: "main",
  };
  expect(await f.transport.pushMergedCommit(center, input)).toEqual({
    status: "pushed",
  });
  expect(await f.transport.pushMergedCommit(center, input)).toEqual({
    status: "pushed",
  });
  const next = await commit(f.source, "next");
  await f.central.syncFromSource(f.project);
  expect(
    await f.transport.pushMergedCommit(center, { ...input, sha: next }),
  ).toEqual({ status: "pushed" });
  const other = join(f.root, "other");
  await git(f.root, "clone", "-b", "main", remote, other);
  const remoteTip = await commit(other, "remote-only");
  await git(other, "push", "origin", "main");
  const localTip = await commit(f.source, "local-only");
  await f.central.syncFromSource(f.project);
  expect(
    await f.transport.pushMergedCommit(center, { ...input, sha: localTip }),
  ).toEqual({ status: "failed", reason: "rejected", exit_code: 1 });
  expect(await git(remote, "rev-parse", "main")).toBe(remoteTip);
  expect(await git(center, "rev-parse", "main")).toBe(localTip);
}, 30_000);
test("a mutable workspace is refused as the push cwd", async () => {
  const f = await centralFixture();
  cleanup.push(f.close);
  const workspace = join(f.root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "marker"), "keep");
  expect(
    await f.transport.pushMergedCommit(workspace, {
      sha: f.initial,
      remote: "file:///unused",
      branch: "main",
    }),
  ).toEqual({ status: "failed", reason: "other" });
});
test.each([
  ["! [rejected] (fetch first)", "rejected"],
  ["Permission denied (publickey). secret", "auth"],
  ["Host key verification failed", "auth"],
  ["Could not resolve hostname private-host", "network"],
  ["fatal: opaque secret", "other"],
])("classifies diagnostics without returning them", (message, expected) => {
  expect(classifyPushFailure(message ?? "")).toBe(expected);
});
