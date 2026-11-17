import { existsSync, lstatSync } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
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

test("reconcile polls refs but transfers and reclassifies only changed source/baseline pairs", async () => {
  const repo = await f.central.ensureCentral(f.project);
  const next = await commit(f.source, "source ahead");
  await git(f.source, "branch", "archive/refs/heads/main", f.initial);
  expect(await f.central.sourceStatus(f.project)).toBe("fast_forwarded");
  f.calls.length = 0;
  expect(await f.central.sourceStatus(f.project)).toBe("fast_forwarded");
  expect(f.calls.some((c) => c.args.includes("fetch"))).toBe(false);
  expect(f.calls.some((c) => c.args.includes("merge-base"))).toBe(false);
  await git(repo, "update-ref", "refs/heads/main", next);
  expect(await f.central.sourceStatus(f.project)).toBe("up_to_date");
  await git(f.source, "reset", "--hard", f.initial);
  expect(await f.central.sourceStatus(f.project)).toBe("ahead");
  expect(await git(repo, "rev-parse", "main")).toBe(next);
  // A missing exact source branch is an error, not an unchanged poll.
  await git(f.source, "update-ref", "-d", "refs/heads/main");
  await expect(f.central.sourceStatus(f.project)).rejects.toThrow();
});

test("backup polls every agent branch, retries failed transfers, restores lost refs and never prunes", async () => {
  const repo = await f.central.ensureCentral(f.project);
  const base = join(f.dataDir, "agent", "repos", f.project.project_id);
  await new LocalGitTransport().ensureClone(repo, base);
  await git(base, "checkout", "-b", "agent/C-1/W-1");
  const first = await commit(base, "first backup");
  const ref = "refs/cardigan/backups/local/agent/C-1/W-1";
  await f.central.backupAgentBranches(f.project, "local");
  f.calls.length = 0;
  // A fresh service has no memory of the previous backup.
  const restarted = new CentralRepositoryService(f.transport, {
    dataDir: f.dataDir,
  });
  await restarted.backupAgentBranches(f.project, "local");
  expect(f.calls.some((c) => c.args.includes("fetch"))).toBe(false);
  const second = await commit(base, "second backup");
  // Git's real ref lock makes this fetch fail after advertisement.
  const lock = join(repo, `${ref}.lock`);
  await writeFile(lock, "held");
  await expect(
    restarted.backupAgentBranches(f.project, "local"),
  ).rejects.toThrow();
  expect(await git(repo, "rev-parse", ref)).toBe(first);
  await rm(lock);
  await restarted.backupAgentBranches(f.project, "local");
  expect(await git(repo, "rev-parse", ref)).toBe(second);
  await git(repo, "update-ref", "-d", ref);
  await restarted.backupAgentBranches(f.project, "local");
  expect(await git(repo, "rev-parse", ref)).toBe(second);
  // Rewinds and new branches are changes too, even without a new object.
  await git(base, "reset", "--hard", first);
  await git(base, "branch", "agent/C-2/W-2", second);
  await restarted.backupAgentBranches(f.project, "local");
  expect(await git(repo, "rev-parse", ref)).toBe(first);
  expect(
    await git(repo, "rev-parse", "refs/cardigan/backups/local/agent/C-2/W-2"),
  ).toBe(second);
  await git(base, "checkout", "main");
  await git(base, "branch", "-D", "agent/C-1/W-1", "agent/C-2/W-2");
  f.calls.length = 0;
  await restarted.backupAgentBranches(f.project, "local");
  expect(f.calls.some((c) => c.args.includes("fetch"))).toBe(false);
  expect(await git(repo, "rev-parse", ref)).toBe(first);
});
test("a bound upload-pack bypasses the refs probe even without an Agent root", async () => {
  const repo = await f.central.ensureCentral(f.project);
  f.calls.length = 0;
  await f.transport.fetchRefs(
    repo,
    f.source,
    ["+refs/heads/main:refs/heads/main"],
    "git-upload-pack",
    true,
  );
  // Identical refs still use the original streaming transfer, without a probe.
  expect(f.calls.some((c) => c.args.includes("ls-remote"))).toBe(false);
  const fetches = f.calls.filter((c) => c.args.includes("fetch"));
  expect(fetches).toHaveLength(1);
  expect(fetches[0]?.args).toContain("--upload-pack=git-upload-pack");
  expect(await git(repo, "rev-parse", "main")).toBe(f.initial);
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
    "refs/heads/candidate:refs/cardigan/candidates/D-2",
  ]);
  await local.fetch(base, repo);
  expect(await local.resolveCommit(base, "refs/cardigan/deliveries/D-1")).toBe(
    sha,
  );
  expect(await local.resolveCommit(base, "refs/cardigan/candidates/D-2")).toBe(
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

test("base fetch leaves automatic maintenance to its owner even above the repack threshold", async () => {
  const repo = await f.central.ensureCentral(f.project),
    base = join(f.root, "base"),
    local = new LocalGitTransport();
  await local.ensureClone(repo, base);
  await git(base, "config", "fetch.unpackLimit", "1");
  await git(base, "config", "gc.auto", "0");
  const sha = await commit(f.source, "another pack");
  await f.central.syncFromSource(f.project);
  await local.fetch(base, repo);
  const packs = async () =>
    (await readdir(join(base, ".git", "objects", "pack")))
      .filter((name) => name.endsWith(".pack"))
      .sort();
  const before = await packs();
  expect(before.length).toBeGreaterThan(1);
  // Force an automatic repack, synchronously, if fetch permits maintenance.
  await git(base, "config", "gc.auto", "1");
  await git(base, "config", "gc.autoPackLimit", "1");
  await git(base, "config", "gc.autoDetach", "false");
  await git(base, "config", "maintenance.autoDetach", "false");
  await local.fetch(base, repo);
  expect(await packs()).toEqual(before);
  expect(await local.resolveCommit(base, "refs/remotes/origin/main")).toBe(sha);
});

test("incremental Agent distribution includes merge candidates without moving the checked-out branch", async () => {
  const repo = await f.central.ensureCentral(f.project),
    agentRoot = join(f.root, "agent"),
    base = join(agentRoot, "repos", "project");
  await mkdir(base, { recursive: true });
  await git(f.root, "clone", f.source, base);
  const previous = await git(base, "rev-parse", "HEAD");
  const sha = await commit(f.source, "candidate");
  await f.transport.fetchRefs(repo, f.source, [
    "refs/heads/main:refs/cardigan/candidates/D-2",
  ]);
  const transport = new CentralGitTransport({ dataDir: f.dataDir, agentRoot });
  await transport.pushBaseline(repo, base, "git receive-pack");
  expect(await git(base, "rev-parse", "refs/cardigan/candidates/D-2")).toBe(
    sha,
  );
  expect(await git(base, "rev-parse", "HEAD")).toBe(previous);
});

test("an executor target on another machine is checked lexically and reached only through the bound receive-pack", async () => {
  const repo = await f.central.ensureCentral(f.project),
    actual = join(f.root, "elsewhere.git");
  await git(f.root, "init", "-q", "--bare", actual);
  const sha = await commit(f.source, "candidate");
  await f.transport.fetchRefs(repo, f.source, [
    "refs/heads/main:refs/cardigan/candidates/D-3",
  ]);
  const transport = new CentralGitTransport({
    dataDir: f.dataDir,
    agentRoot: join(f.root, "agent"),
  });
  const bound = `sh -c 'exec git receive-pack ${actual}' --`;
  // The executor root does not exist on this disk: nothing is resolved here.
  await transport.pushBaseline(
    repo,
    "/srv/remote-agent/repos/project",
    bound,
    "/srv/remote-agent",
  );
  expect(await git(actual, "rev-parse", "refs/cardigan/candidates/D-3")).toBe(
    sha,
  );
  for (const [root, target] of [
    ["/srv/remote-agent", "/srv/remote-agent/worktrees/project"],
    ["/srv/remote-agent", "/srv/remote-agent/repos/../repos/project"],
    ["/srv/remote-agent", "/srv/remote-agent/repos/-project"],
    ["/srv/remote-agent", "/srv/other/repos/project"],
    ["/srv/remote-agent/", "/srv/remote-agent/repos/project"],
    ["relative", "relative/repos/project"],
    ["/", "/repos/project"],
  ])
    await expect(
      transport.pushBaseline(repo, target, bound, root),
    ).rejects.toThrow(/Agent repository/);
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

test("missing legacy clones are skipped before constructing the SSH upload entry", async () => {
  const uploadPack = vi.fn(async () => {
    throw new Error("SSH entry should not be needed");
  });
  const central = new CentralRepositoryService(f.transport, {
    dataDir: f.dataDir,
    uploadPack,
  });
  await expect(
    central.backupAgentBranches(f.project, "local"),
  ).resolves.toBeUndefined();
  expect(uploadPack).not.toHaveBeenCalled();
});

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

test.each(["bundle", "file", "symlink"] as const)(
  "worker transfers ignore a controller-local %s at the same path",
  async (kind) => {
    const repository = await f.central.ensureCentral(f.project);
    const worker = join(f.root, "worker-disk"),
      spoof = join(f.root, "spoof");
    for (const path of [worker, spoof]) {
      await git(f.root, "clone", f.source, path);
      await git(path, "switch", "-c", "agent/C-1/W-1");
    }
    const real = await commit(worker, "worker truth");
    const falseHead = await commit(spoof, "host spoof");
    const bundle = join(f.root, "spoof.bundle");
    await git(spoof, "bundle", "create", bundle, "--all");
    const root = join(f.root, "worker-address"),
      path = join(root, "repos", "project");
    await mkdir(dirname(path), { recursive: true });
    if (kind === "bundle") await writeFile(path, await readFile(bundle));
    else if (kind === "symlink") await symlink(bundle, path);
    else await writeFile(path, "not a repository");
    const before = await readFile(path);
    const trace = join(f.root, "pack.trace");
    const entry = async (service: string) => {
      const script = join(f.root, `${service}.sh`);
      await writeFile(
        script,
        `#!/bin/sh\nprintf '%s\\n' ${quote(service)} >> ${quote(trace)}\nexec git ${service} ${quote(worker)}\n`,
        { mode: 0o700 },
      );
      return quote(script);
    };
    const endpoints: string[] = [];
    const transport = new CentralGitTransport({
      dataDir: f.dataDir,
      onCommand: (_, args) => {
        if (!args.includes("fetch") && !args.includes("push")) return;
        const endpoint = args[args.indexOf("--") + 1];
        expect(endpoint).toBeDefined();
        if (!endpoint) throw new Error("No transport endpoint");
        expect(endpoint).not.toBe(path);
        expect(endpoint.startsWith(`${transport.root}/`)).toBe(true);
        expect(existsSync(endpoint)).toBe(false);
        expect(lstatSync(dirname(endpoint)).mode & 0o777).toBe(0o700);
        endpoints.push(endpoint);
      },
    });
    const address = {
      kind: "worker-remote" as const,
      path,
      root,
      project_id: "project",
      machine_id: "worker-a",
    };
    for (const invalid of [
      `${root}/repos/.clone-project-${"a".repeat(32)}`,
      `${root}/repos/other/.clone-project-${"a".repeat(32)}`,
      `${root}/repos/project/.clone-other-${"a".repeat(32)}`,
      `${root}/repos/project/.clone-project-short`,
    ])
      await expect(
        transport.pushBaseline(
          repository,
          { ...address, path: invalid },
          "must-not-run",
        ),
      ).rejects.toThrow("Baseline push requires an Agent repository");
    const ref = "refs/cardigan/backups/worker-a/agent/C-1/W-1";
    await transport.fetchRefs(
      repository,
      address,
      [`+refs/heads/agent/C-1/W-1:${ref}`],
      await entry("upload-pack"),
      true,
    );
    expect(await transport.readRef(repository, ref)).toBe(real);
    expect(await transport.readRef(repository, ref)).not.toBe(falseHead);
    await transport.pushBaseline(
      repository,
      address,
      await entry("receive-pack"),
    );
    expect(await git(worker, "rev-parse", "refs/remotes/origin/main")).toBe(
      f.initial,
    );
    expect((await readFile(trace, "utf8")).trim().split("\n")).toEqual([
      "upload-pack",
      "receive-pack",
    ]);
    await expect(
      transport.fetchRefs(
        repository,
        address,
        [`+refs/heads/agent/C-1/W-1:${ref}`],
        "false",
        true,
      ),
    ).rejects.toThrow();
    expect(await transport.readRef(repository, ref)).toBe(real);
    expect(await readFile(path)).toEqual(before);
    for (const endpoint of endpoints)
      await expect(access(dirname(endpoint))).rejects.toMatchObject({
        code: "ENOENT",
      });
  },
);
