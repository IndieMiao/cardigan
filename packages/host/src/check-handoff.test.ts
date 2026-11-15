import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectId } from "@cardigan/domain";
import { CheckHandoffs, Store } from "@cardigan/store";
import { afterEach, expect, test } from "vitest";
import { fixtureCheckProbe } from "../../../test-support/check-handoff-probe.js";
import { acquireMergeCheckCapacity } from "./merge-check-capacity.js";
import { acquireRepositoryFlock } from "./repository-lock.js";

const roots: string[] = [];
const owned: number[] = [];
const checkTargetIdle = fixtureCheckProbe(() => owned);
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "handoff-probe-"));
  roots.push(dataDir);
  const repo = join(dataDir, "agent", "repos", "project");
  await mkdir(repo, { recursive: true });
  execFileSync("git", ["init", "--bare", repo], { stdio: "ignore" });
  await writeFile(join(dataDir, "merge-check.lock"), "", { mode: 0o600 });
  return { dataDir, repo, execution: { mode: "local" as const, dataDir } };
}
test("original slot occupancy, leftover containers, aliases and registry each block the real idle probe", async () => {
  const f = await fixture();
  await checkTargetIdle(f.execution, 1);
  const unlock = await acquireRepositoryFlock(
    join(f.dataDir, "merge-check.lock"),
    100,
  );
  await expect(checkTargetIdle(f.execution, 1)).rejects.toThrow();
  await unlock();
  const leftover = join(
    f.dataDir,
    "agent",
    "checks",
    "project",
    "unknown-attempt",
  );
  await mkdir(leftover, { recursive: true });
  await writeFile(join(leftover, "manual-attention"), "keep");
  await expect(checkTargetIdle(f.execution, 1)).rejects.toThrow();
  expect(await readFile(join(leftover, "manual-attention"), "utf8")).toBe(
    "keep",
  );
  await rm(leftover, { recursive: true });
  const alias = join(f.dataDir, "s");
  await mkdir(alias);
  await mkdir(join(alias, "unknown"));
  await expect(checkTargetIdle(f.execution, 1)).rejects.toThrow();
  await rm(join(alias, "unknown"), { recursive: true });
  const registry = join(f.repo, "worktrees", "stale");
  await mkdir(registry, { recursive: true });
  await writeFile(
    join(registry, "gitdir"),
    `${f.dataDir}/agent/checks/project/dead/worktree/.git\n`,
  );
  await writeFile(join(registry, "HEAD"), "a".repeat(40));
  await writeFile(join(registry, "commondir"), "../..\n");
  await expect(checkTargetIdle(f.execution, 1)).rejects.toThrow();
  await rm(join(f.repo, "worktrees"), { recursive: true });
  await checkTargetIdle(f.execution, 1);
});
test("missing or replaced original locks never become idle or get created by the probe", async () => {
  const f = await fixture();
  const lock = join(f.dataDir, "merge-check.lock");
  await rm(lock);
  await expect(checkTargetIdle(f.execution, 1)).rejects.toThrow();
  await expect(readFile(lock)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(join(f.dataDir, "other-lock"), "");
  await symlink(join(f.dataDir, "other-lock"), lock);
  await expect(checkTargetIdle(f.execution, 1)).rejects.toThrow();
});
test("the original capacity ledger admits only the current holder and late ownership transfer fails", () => {
  const store = Store.open({ dbPath: ":memory:" });
  try {
    const project = "project" as ProjectId;
    store.createProject({ id: project });
    const normal = acquireMergeCheckCapacity(store, project, "normal");
    const facts = new CheckHandoffs(store, "controller");
    facts.begin(project, "local", "binding");
    expect(() =>
      acquireMergeCheckCapacity(store, project, "blocked"),
    ).toThrow();
    normal(); // The fence never interrupts original execution's cleanup/release.
    const grant = facts.claim(project, "local", 1, "binding", "holder");
    const lease = acquireMergeCheckCapacity(
      store,
      project,
      "measurement",
      undefined,
      "local",
      grant,
    );
    new CheckHandoffs(store, "restart").recover();
    expect(() => lease.transfer({ pid: process.pid, start: "late" })).toThrow();
    expect(() =>
      acquireMergeCheckCapacity(
        store,
        project,
        "late",
        undefined,
        "local",
        grant,
      ),
    ).toThrow();
    lease();
    expect(
      store.database.prepare("SELECT * FROM merge_check_capacity").all(),
    ).toHaveLength(0);
  } finally {
    store.close();
  }
});

test("a process retaining a deleted check cwd blocks restoration despite free locks and empty directory listings", async () => {
  const f = await fixture();
  const container = join(f.dataDir, "agent", "checks", "project", "deleted");
  await mkdir(container, { recursive: true });
  const child = spawn(
    process.execPath,
    ["-e", "process.stdout.write('ready'); process.stdin.resume()"],
    {
      cwd: container,
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  if (child.pid) owned.push(child.pid);
  try {
    await once(child.stdout, "data");
    await rmdir(container);
    await expect(checkTargetIdle(f.execution, 1)).rejects.toThrow();
  } finally {
    child.stdin.end();
    await once(child, "exit");
  }
  await checkTargetIdle(f.execution, 1);
});
