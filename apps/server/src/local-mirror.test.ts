import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  CentralGitTransport,
  LocalGitTransport,
} from "@cardigan/git-transport";
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

test.each(["local", "agent-ssh", "legacy-bundle"])(
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
    git(center, "branch", "integration", parent);
    git(dataDir, "clone", "-q", "--no-local", center, mirror);
    const dotGit = join(mirror, ".git");
    git(mirror, "config", "core.sharedRepository", "0660");
    const gitPermissions = permissions(dotGit);
    const inputs = join(agentRoot, "inputs", f.project_id),
      bundle = join(inputs, "source.bundle"),
      record = join(inputs, "source.path");
    if (mode === "legacy-bundle") {
      mkdirSync(inputs, { recursive: true });
      for (const dir of [agentRoot, join(agentRoot, "inputs"), inputs])
        chmodSync(dir, 0o2750);
      writeFileSync(record, center, { mode: 0o600 });
      git(mirror, "remote", "set-url", "origin", bundle);
    }
    git(mirror, "branch", "integration", parent);
    git(mirror, "update-ref", "refs/remotes/elsewhere/integration", parent);
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
    git(center, "branch", "-D", "integration");
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
    // Inverse D/F conflict: remove the stale child so its parent can be a ref.
    git(center, "branch", "-D", "integration/dynamicfarm");
    git(center, "branch", "integration", merged);
    await executor.tick();
    expect(report).not.toHaveBeenCalled();
    expect(git(mirror, "rev-parse", "refs/remotes/origin/integration")).toBe(
      merged,
    );
    expect(
      git(
        mirror,
        "for-each-ref",
        "refs/remotes/origin/integration/dynamicfarm",
      ),
    ).toBe("");
    expect(git(mirror, "rev-parse", "refs/remotes/elsewhere/integration")).toBe(
      parent,
    );
    expect(heads()).toBe(headsBefore);
    if (mode === "legacy-bundle") {
      const refused = async () => {
        report.mockClear();
        await executor.tick();
        expect(report).toHaveBeenCalledWith(
          `Local mirror refresh failed for ${f.project_id}`,
        );
        expect(
          git(mirror, "rev-parse", "refs/remotes/origin/integration"),
        ).toBe(merged);
      };
      // A bundle URL alone is not proof: require this project's prior host record.
      git(center, "branch", "-f", "integration", parent);
      git(
        mirror,
        "remote",
        "set-url",
        "origin",
        join(agentRoot, "inputs/other/source.bundle"),
      );
      await refused();
      git(mirror, "remote", "set-url", "origin", bundle);
      writeFileSync(record, source);
      await refused();
      unlinkSync(record);
      await refused();
      expect(existsSync(record)).toBe(false);
      const elsewhere = join(dataDir, "foreign-record");
      writeFileSync(elsewhere, center, { mode: 0o600 });
      symlinkSync(elsewhere, record);
      await refused();
      unlinkSync(record);
      writeFileSync(record, center, { mode: 0o600 });
      report.mockClear();
      await executor.tick();
      expect(report).not.toHaveBeenCalled();
      expect(git(mirror, "rev-parse", "origin/integration")).toBe(parent);
      expect(readFileSync(join(dotGit, "config"))).toEqual(configBefore);
    }
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
  // An old machine-local URL mapping is not the verified center. Reject it
  // before starting any transfer or deleting a conflicting tracking ref.
  const mapping = `url.${join(f.dataDir, "retired-center")}.insteadOf`;
  git(mirror, "config", mapping, center);
  git(mirror, "update-ref", "refs/remotes/origin/new-host-branch/old", "HEAD");
  const refs = () =>
    git(mirror, "for-each-ref", "--format=%(refname) %(objectname)");
  const before = refs();
  const transfer = vi.spyOn(
    CentralGitTransport.prototype,
    "distributeMirrorHeads",
  );
  const clear = vi.spyOn(
    LocalGitTransport.prototype,
    "clearMirrorNameConflicts",
  );
  try {
    report.mockClear();
    await executor.tick();
    expect(report).toHaveBeenCalledWith(
      `Local mirror refresh failed for ${f.project_id}`,
    );
    expect(transfer).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(refs()).toBe(before);
  } finally {
    transfer.mockRestore();
    clear.mockRestore();
  }
  git(mirror, "config", "--unset", mapping);
  await executor.tick();
  expect(git(mirror, "rev-parse", "origin/new-host-branch")).toBe(
    git(center, "rev-parse", "new-host-branch"),
  );
});
