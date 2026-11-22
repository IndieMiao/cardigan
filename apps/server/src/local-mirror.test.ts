import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentExecution } from "@cardigan/runtime-herdr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ServerGit } from "./git.js";
import { type M4Fixture, m4Fixture } from "./m4-fixtures.js";
import { ReconcileExecutor } from "./reconcile-loop.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
const permissions = (path: string) => {
  const { uid, gid, mode } = statSync(path);
  return { uid, gid, mode };
};
let f: M4Fixture;
let source: string;
beforeEach(() => {
  f = m4Fixture({ project_id: "sensen-godot" });
  source = join(f.dataDir, "source");
  git(f.dataDir, "init", "-q", "-b", "farm-dev", source);
  writeFileSync(join(source, "farm"), "original");
  git(source, "add", "farm");
  git(source, "commit", "-qm", "base");
  f.store.setProjectRepo({
    project_id: f.project_id,
    repo_path: source,
    base_branch: "farm-dev",
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  f.close();
});

test.each(["local", "agent-ssh"])(
  "%s: one reconciliation refreshes center branches without a local Assignment",
  async (mode) => {
    const { dataDir } = f;
    const agentRoot = join(dataDir, mode === "local" ? "agent" : "isolated");
    const mirror = join(agentRoot, "repos", f.project_id);
    const execution: AgentExecution = {
      mode: "agent-ssh",
      dataDir,
      agentRoot,
      gid: process.getgid?.() ?? 0,
      machine: "local",
      identityFile: join(dataDir, "identity"),
      knownHostsFile: join(dataDir, "hosts"),
    };
    // Only replace SSH itself. Exercise the production bound receive-pack command
    // and its ref protections with real Git, without requiring a system account.
    const bin = join(dataDir, "bin");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "ssh"),
      '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift 2\nexec sh -c "$*"\n',
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
    for (const path of [execution.identityFile, execution.knownHostsFile])
      writeFileSync(path, "fixture", { mode: 0o600 });
    const captureAgent = vi.fn(
      async (_command: "git", args: readonly string[]) => ({
        ok: true as const,
        value: git(dataDir, ...args),
      }),
    );
    const binding = new ServerGit({
      dataDir,
      store: f.store,
      ...(mode === "local" ? {} : { execution, captureAgent }),
    });
    const project = binding.projectOf(f.project_id);
    if (!project) throw new Error("missing fixture");
    await binding.sync(project);
    const center = join(dataDir, "central", `${f.project_id}.git`);
    const parent = git(center, "rev-parse", "farm-dev");
    git(center, "branch", "retired", parent);
    git(dataDir, "clone", "-q", "--no-local", center, mirror);
    const dotGit = join(mirror, ".git");
    git(mirror, "config", "core.sharedRepository", "0660");
    const gitPermissions = permissions(dotGit);
    const configBefore = readFileSync(join(dotGit, "config"));
    const heads = () =>
      git(
        mirror,
        "for-each-ref",
        "--format=%(refname) %(objectname)",
        "refs/heads",
      );
    const headsBefore = heads();
    writeFileSync(join(mirror, "farm"), "uncommitted");
    writeFileSync(join(mirror, "notes"), "untracked");

    // Remote-only development: the merge reaches the center, not the registered
    // source or the local clone. The host creates a new integration branch there.
    const worker = join(dataDir, "worker");
    git(dataDir, "clone", "-q", center, worker);
    git(worker, "checkout", "-qb", "feature", parent);
    git(worker, "commit", "--allow-empty", "-qm", "worker change");
    git(worker, "checkout", "-q", "farm-dev");
    git(worker, "merge", "--no-ff", "-qm", "remote merge", "feature");
    const merged = git(worker, "rev-parse", "HEAD");
    git(
      center,
      "fetch",
      "-q",
      worker,
      "refs/heads/farm-dev:refs/heads/farm-dev",
    );
    git(center, "branch", "integration/dynamicfarm", merged);
    git(center, "branch", "-D", "retired");
    git(center, "update-ref", "refs/cardigan/candidates/A-1", merged);
    git(center, "tag", "unrelated", merged);
    const report = vi.fn();
    const executor = new ReconcileExecutor({
      store: f.store,
      git: binding,
      report,
    });
    await executor.tick();
    expect(report).not.toHaveBeenCalled();
    for (const branch of ["farm-dev", "integration/dynamicfarm"])
      expect(git(mirror, "rev-parse", `origin/${branch}`)).toBe(merged);
    expect(git(mirror, "symbolic-ref", "refs/remotes/origin/HEAD")).toBe(
      "refs/remotes/origin/farm-dev",
    );
    expect(
      git(
        mirror,
        "for-each-ref",
        "refs/remotes/origin/retired",
        "refs/cardigan",
        "refs/tags",
      ),
    ).toBe("");
    expect(heads()).toBe(headsBefore);
    expect(git(mirror, "rev-parse", "HEAD")).toBe(parent);
    expect(git(mirror, "status", "--porcelain")).toBe("M farm\n?? notes");
    expect(readFileSync(join(mirror, "farm"), "utf8")).toBe("uncommitted");
    expect(readFileSync(join(dotGit, "config"))).toEqual(configBefore);
    expect(permissions(dotGit)).toEqual(gitPermissions);
    const ref = permissions(
      join(dotGit, "refs/remotes/origin/integration/dynamicfarm"),
    );
    expect([ref.uid, ref.gid]).toEqual([
      gitPermissions.uid,
      gitPermissions.gid,
    ]);
    expect(ref.mode & 0o666).toBe(0o660);
    if (mode !== "local") expect(captureAgent).toHaveBeenCalled();
    // A forced host-side update is independent of both the merge event and base SHA.
    git(center, "branch", "-f", "integration/dynamicfarm", parent);
    await executor.tick();
    expect(git(mirror, "rev-parse", "origin/integration/dynamicfarm")).toBe(
      parent,
    );
    git(
      mirror,
      "symbolic-ref",
      "refs/remotes/origin/custom-alias",
      "refs/heads/farm-dev",
    );
    await executor.tick();
    expect(report).toHaveBeenCalledWith(
      `Local mirror refresh failed for ${f.project_id}`,
    );
    expect(heads()).toBe(headsBefore);
  },
);

test("missing mirror stays absent; a foreign origin is reported without changing its refs", async () => {
  const binding = new ServerGit({ dataDir: f.dataDir, store: f.store });
  const report = vi.fn();
  const executor = new ReconcileExecutor({
    store: f.store,
    git: binding,
    report,
  });
  const mirror = join(f.dataDir, "agent/repos", f.project_id);
  await executor.tick();
  expect(existsSync(mirror)).toBe(false);
  expect(report).not.toHaveBeenCalled();
  const project = binding.projectOf(f.project_id);
  if (!project) throw new Error("missing fixture");
  await binding.sync(project);
  git(f.dataDir, "clone", "-q", source, mirror);
  const center = join(f.dataDir, "central", `${f.project_id}.git`);
  git(center, "branch", "new-host-branch", "farm-dev");
  await executor.tick();
  expect(report).toHaveBeenCalledWith(
    `Local mirror refresh failed for ${f.project_id}`,
  );
  expect(
    git(mirror, "for-each-ref", "refs/remotes/origin/new-host-branch"),
  ).toBe("");
  git(mirror, "remote", "set-url", "origin", center);
  await executor.tick();
  expect(git(mirror, "rev-parse", "origin/new-host-branch")).toBe(
    git(center, "rev-parse", "new-host-branch"),
  );
});
