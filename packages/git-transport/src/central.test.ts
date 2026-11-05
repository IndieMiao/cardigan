import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { CentralRepositoryService } from "@cardigan/git-service";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { centralFixture, commit, git } from "../test-support/git.js";
import { CentralGitTransport } from "./central.js";
import { LocalGitTransport } from "./index.js";

let f: Awaited<ReturnType<typeof centralFixture>>;
beforeEach(async () => {
  f = await centralFixture();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await f.close();
});

test("central clone is private, bare, independent and bound to its registered source", async () => {
  const before = await git(f.source, "show-ref"),
    repo = await f.central.ensureCentral(f.project);
  expect(repo).toBe(join(f.dataDir, "central", "project.git"));
  expect(await git(repo, "rev-parse", "--is-bare-repository")).toBe("true");
  expect((await lstat(repo)).mode & 0o777).toBe(0o700);
  await expect(
    access(join(repo, "objects", "info", "alternates")),
  ).rejects.toThrow();
  expect(await f.central.ensureCentral(f.project)).toBe(repo);
  const other = join(f.root, "other");
  await git(f.root, "clone", f.source, other);
  await expect(
    f.central.ensureCentral({ ...f.project, source_repo: other }),
  ).rejects.toThrow(/source changed/);
  expect(await git(f.source, "show-ref")).toBe(before);
  expect(
    f.calls.every((c) => c.cwd.startsWith(join(f.dataDir, "central"))),
  ).toBe(true);
  expect(
    f.calls.every(
      (c) =>
        c.args.includes("transfer.fsckObjects=true") &&
        c.args.includes("core.hooksPath=/dev/null"),
    ),
  ).toBe(true);
});
test("source synchronization fast-forwards, preserves a leading center and refuses divergence", async () => {
  const repo = await f.central.ensureCentral(f.project);
  expect(await f.central.syncFromSource(f.project)).toBe("up_to_date");
  const next = await commit(f.source, "source forward");
  expect(await f.central.syncFromSource(f.project)).toBe("fast_forwarded");
  expect(await git(repo, "rev-parse", "main")).toBe(next);
  await git(f.source, "reset", "--hard", f.initial);
  expect(await f.central.syncFromSource(f.project)).toBe("ahead");
  const fork = await commit(f.source, "diverged source");
  expect(await f.central.syncFromSource(f.project)).toBe("diverged");
  expect(await git(repo, "rev-parse", "main")).toBe(next);
  expect(await git(repo, "rev-parse", "refs/cardigan/source/main")).toBe(fork);
  expect(await git(f.source, "rev-parse", "main")).toBe(fork);
});
test("ref comparison rejects stale updates instead of overwriting the current baseline", async () => {
  const repo = await f.central.ensureCentral(f.project),
    next = await commit(f.source, "next");
  await f.central.syncFromSource(f.project);
  await expect(
    f.transport.compareAndSwapRef(
      repo,
      "refs/heads/main",
      f.initial,
      f.initial,
    ),
  ).rejects.toThrow();
  expect(await git(repo, "rev-parse", "main")).toBe(next);
});
test("central Git ignores injected Git environment and global configuration", async () => {
  const config = join(f.root, "host.gitconfig");
  await writeFile(
    config,
    '[protocol "file"]\nallow = never\n[core]\nsharedRepository = 0777\n',
  );
  vi.stubEnv("GIT_CONFIG_GLOBAL", config);
  vi.stubEnv("GIT_DIR", join(f.root, "missing"));
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", "protocol.file.allow");
  vi.stubEnv("GIT_CONFIG_VALUE_0", "never");
  const repo = await f.central.ensureCentral(f.project);
  expect(await f.transport.readRef(repo, "refs/heads/main")).toBe(f.initial);
  expect((await lstat(repo)).mode & 0o777).toBe(0o700);
});
test("unsafe roots, project components and symlinked central repositories are rejected", async () => {
  for (const project_id of ["", "..", "../x", "x/y", "-x"])
    await expect(
      f.central.ensureCentral({ ...f.project, project_id }),
    ).rejects.toThrow(/component/);
  const shared = join(f.root, "shared");
  await mkdir(shared);
  await chmod(shared, 0o777);
  const options = { dataDir: f.dataDir, centralRoot: join(shared, "central") };
  await expect(
    new CentralRepositoryService(
      new CentralGitTransport(options),
      options,
    ).ensureCentral(f.project),
  ).rejects.toThrow(/ancestor/);
  await mkdir(f.dataDir, { mode: 0o700 });
  const root = join(f.dataDir, "central");
  await mkdir(root, { recursive: true });
  await chmod(root, 0o777);
  await expect(f.central.ensureCentral(f.project)).rejects.toThrow(/private/);
  await chmod(root, 0o700);
  await symlink(f.source, join(root, "project.git"));
  await expect(f.central.ensureCentral(f.project)).rejects.toThrow(
    /without symlinks/,
  );
  expect(
    () => new CentralGitTransport({ dataDir: f.dataDir, agentRoot: f.root }),
  ).toThrow(/outside/);
  const isolated = new CentralRepositoryService(
    new CentralGitTransport({ dataDir: f.dataDir, agentRoot: f.source }),
    { dataDir: f.dataDir },
  );
  await expect(isolated.ensureCentral(f.project)).rejects.toThrow();
});
test("base clone fetches fixed delivery refs from center and rejects legacy sources", async () => {
  const repo = await f.central.ensureCentral(f.project),
    base = join(f.root, "base"),
    old = join(f.root, "old");
  const local = new LocalGitTransport();
  await local.ensureClone(f.source, old);
  await expect(local.ensureClone(repo, old)).rejects.toThrow(/rebuild/);
  await local.ensureClone(repo, base);
  await git(f.source, "switch", "-c", "candidate");
  const sha = await commit(f.source, "delivery only");
  await f.transport.fetchRefs(repo, f.source, [
    "refs/heads/candidate:refs/cardigan/deliveries/D-1",
  ]);
  await local.fetch(base, repo);
  expect(await local.resolveCommit(base, "refs/cardigan/deliveries/D-1")).toBe(
    sha,
  );
  await rm(join(base, ".git", "objects"), { recursive: true });
  await mkdir(join(base, ".git", "objects"));
  await local.fetch(base, repo);
  expect(await local.resolveCommit(base, "refs/cardigan/deliveries/D-1")).toBe(
    sha,
  );
  expect(await readFile(join(base, ".git", "config"), "utf8")).toContain(repo);
});

test("a missing initial baseline never publishes a partial center and can be retried after the first commit", async () => {
  const source = join(f.root, "empty");
  await git(f.root, "init", "-b", "main", source);
  const project = { ...f.project, project_id: "empty", source_repo: source };
  await expect(f.central.ensureCentral(project)).rejects.toThrow(
    /baseline branch is missing/,
  );
  await expect(
    access(join(f.dataDir, "central", "empty.git")),
  ).rejects.toThrow();
  const sha = await commit(source, "first");
  const center = await f.central.ensureCentral(project);
  expect(await f.transport.readRef(center, "refs/heads/main")).toBe(sha);
});
