import { chmod, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { centralFixture, commit, git } from "../test-support/git.js";
import { CentralGitTransport } from "./central.js";

let f: Awaited<ReturnType<typeof centralFixture>>;
beforeEach(async () => {
  f = await centralFixture();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await f.close();
});

test("synchronous center reads observe loose and packed refs and ref changes without caching", async () => {
  const repo = await f.central.ensureCentral(f.project);
  expect(f.transport.readRefSync(repo, "refs/heads/main")).toBe(f.initial);
  await git(repo, "pack-refs", "--all", "--prune");
  expect(f.transport.readRefSync(repo, "refs/heads/main")).toBe(f.initial);
  const next = await commit(f.source, "next");
  await git(repo, "fetch", f.source, "+refs/heads/main:refs/heads/main");
  expect(f.transport.readRefSync(repo, "refs/heads/main")).toBe(next);
  expect(f.transport.readRefSync(repo, "refs/heads/missing")).toBeUndefined();
  expect(f.transport.readRefSync(repo, "--output=/tmp/forged")).toBeUndefined();
  expect(f.transport.readRefSync(repo, "main")).toBeUndefined();
  expect(
    f.calls.every((c) => c.args.includes("core.hooksPath=/dev/null")),
  ).toBe(true);
});

test("transaction ref reads keep host path and ambient Git boundaries", async () => {
  const repo = await f.central.ensureCentral(f.project);
  vi.stubEnv("GIT_DIR", f.source);
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", "core.bare");
  vi.stubEnv("GIT_CONFIG_VALUE_0", "false");
  expect(f.transport.readRefSync(repo, "refs/heads/main")).toBe(f.initial);
  expect(f.transport.readRefSync(f.source, "refs/heads/main")).toBeUndefined();
  const alias = join(f.transport.root, "alias.git");
  await symlink(repo, alias);
  expect(f.transport.readRefSync(alias, "refs/heads/main")).toBeUndefined();
  await chmod(repo, 0o770);
  expect(f.transport.readRefSync(repo, "refs/heads/main")).toBeUndefined();
});

test("an invalid existing query timeout fails closed before executing Git", async () => {
  const repo = await f.central.ensureCentral(f.project);
  const transport = new CentralGitTransport({
    dataDir: f.dataDir,
    queryTimeoutMs: 0,
  });
  expect(transport.readRefSync(repo, "refs/heads/main")).toBeUndefined();
});
