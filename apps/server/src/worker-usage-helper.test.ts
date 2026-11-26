/**
 * C-666: the release helper's `usage` report, run for real (deploy/
 * worker-git.py) on a separate fixture disk through the pinned SSH entry.
 * Only SSH (a local shell) and the administrator ownership of the namespace
 * are simulated, as in the other worker Git fixtures.
 */
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WorkerUsageReport, workerGit } from "@cardigan/runtime-herdr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { workerGitFixture } from "../../cli/test-support/worker-git.js";

const PROJECT = "sensen";
const MiB = 1024 * 1024;
let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cg-worker-usage-")));
  writeFileSync(
    join(root, "ssh"),
    '#!/bin/sh\nfor cmd do :; done\nexec sh -c "$cmd"\n',
    {
      mode: 0o700,
    },
  );
  vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function worker(platform: "linux" | "darwin") {
  const fixture = await workerGitFixture(
    root,
    {
      mode: "agent-ssh",
      dataDir: root,
      agentRoot: "/worker-fixture",
      gid: process.getgid?.() ?? 0,
      machine: "worker-a",
      identityFile: join(root, "key"),
      knownHostsFile: join(root, "known"),
    },
    "worker-a",
    platform,
    PROJECT,
  );
  for (const path of [join(root, "key"), join(root, "known")])
    writeFileSync(path, "fixture", { mode: 0o600 });
  const file = (path: string, bytes: number) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, Buffer.alloc(bytes, 1));
  };
  const leaf = (kind: string, id: string) =>
    join(fixture.disk, kind, PROJECT, id);
  file(join(leaf("worktrees", "A-1"), "src", "big.bin"), 3 * MiB);
  file(join(leaf("worktrees", "A-2"), "small.bin"), MiB);
  file(join(leaf("builds", "A-3"), ".godot", "imported", "a.ctex"), 2 * MiB);
  // A hard link is one allocation; a symlink is never followed.
  linkSync(
    join(leaf("builds", "A-3"), ".godot", "imported", "a.ctex"),
    join(leaf("builds", "A-3"), "same.ctex"),
  );
  file(join(root, "outside", "elsewhere.bin"), 8 * MiB);
  symlinkSync(join(root, "outside"), join(leaf("builds", "A-3"), "escape"));
  file(join(leaf("runs", "A-4"), "log"), MiB / 2);
  return fixture;
}

const usage = (
  config: Awaited<ReturnType<typeof worker>>["config"],
  project = PROJECT,
) =>
  workerGit<WorkerUsageReport>(
    { ...config, target: { ...required(config.target), project_id: project } },
    { operation: "usage", project, assignment: "A-1", timeout_ms: 20_000 },
  );
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture");
  return value;
}
function tree(path: string): string[] {
  return readdirSync(path, { recursive: true, withFileTypes: true }).map(
    (e) =>
      `${join(e.parentPath, e.name)}:${statSync(join(e.parentPath, e.name), { throwIfNoEntry: false })?.mtimeMs ?? "link"}`,
  );
}

test.each(["linux", "darwin"] as const)(
  "the %s helper reports each kind of the project's own directories and the volume, read-only",
  async (platform) => {
    const fixture = await worker(platform);
    const before = tree(fixture.disk);
    const report = await usage(fixture.config);
    expect(tree(fixture.disk)).toEqual(before);
    const within = (bytes: number, expected: number) => {
      // Allocation rounds up per file and counts directory blocks.
      expect(bytes).toBeGreaterThanOrEqual(expected);
      expect(bytes).toBeLessThan(expected + MiB / 2);
    };
    within(report.worktrees.bytes, 4 * MiB);
    within(report.builds.bytes, 2 * MiB);
    within(report.runs.bytes, MiB / 2);
    expect(report.worktrees.directories).toBe(2);
    expect(report.builds.directories).toBe(1);
    expect(report.runs.directories).toBe(1);
    expect(report.complete).toBe(true);
    expect(report.total_bytes).toBeGreaterThan(0);
    expect(report.free_bytes).toBeGreaterThan(0);
    expect(report.free_bytes).toBeLessThanOrEqual(report.total_bytes);
  },
);

test("an unreadable directory is reported as an incomplete walk, not a failure", async () => {
  const fixture = await worker("linux");
  const locked = join(fixture.disk, "builds", PROJECT, "A-3", ".godot");
  chmodSync(locked, 0);
  try {
    const report = await usage(fixture.config);
    // Root can still read it; only an unprivileged account sees the gap.
    if (process.getuid?.() !== 0) expect(report.complete).toBe(false);
    expect(report.worktrees.bytes).toBeGreaterThanOrEqual(4 * MiB);
  } finally {
    chmodSync(locked, 0o700);
  }
});

test("another project's name is refused: the helper reads only its own account's leaves", async () => {
  const fixture = await worker("linux");
  await expect(usage(fixture.config, "cardigan")).rejects.toThrow(
    /Worker Git operation failed \(usage:/u,
  );
});
