import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectId } from "@cardigan/domain";
import type { CentralProject } from "@cardigan/git-service";
import type {
  CentralRepackMode,
  CentralRepackResult,
} from "@cardigan/git-transport";
import { afterEach, expect, test, vi } from "vitest";
import {
  CentralMaintenanceExecutor,
  type CentralMaintenanceGit,
  DEFAULT_CENTRAL_CRUFT_INTERVAL_MS,
  parseMaintenanceWindow,
  windowOccurrence,
} from "./central-maintenance-loop.js";
import { ServerGit } from "./git.js";
import { type M4Fixture, m4Fixture } from "./m4-fixtures.js";

const local = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute);
const window = { start: 3 * 60, end: 6 * 60 };

test("C-637: maintenance window is HH:MM-HH:MM local time, may wrap, or off", () => {
  expect(parseMaintenanceWindow("03:00-06:00")).toEqual(window);
  expect(parseMaintenanceWindow(" 23:30-01:15 ")).toEqual({
    start: 23 * 60 + 30,
    end: 75,
  });
  expect(parseMaintenanceWindow("off")).toBeUndefined();
  for (const bad of [
    "3:00-6:00",
    "03:00-03:00",
    "24:00-01:00",
    "03:00-06:00-07:00",
    "03:00",
    "",
  ])
    expect(() => parseMaintenanceWindow(bad)).toThrow(/HH:MM-HH:MM/);
});

test("C-637: one occurrence per window, keyed by the local date it opened", () => {
  expect(windowOccurrence(window, local(23, 2, 59))).toBeUndefined();
  expect(windowOccurrence(window, local(23, 3))).toBe("2026-11-23");
  expect(windowOccurrence(window, local(23, 5, 59))).toBe("2026-11-23");
  expect(windowOccurrence(window, local(23, 6))).toBeUndefined();
  const night = { start: 23 * 60, end: 2 * 60 };
  expect(windowOccurrence(night, local(23, 23, 30))).toBe("2026-11-23");
  expect(windowOccurrence(night, local(24, 1, 30))).toBe("2026-11-23");
  expect(windowOccurrence(night, local(1, 0, 10))).toBe("2026-10-31");
  expect(windowOccurrence(night, local(24, 2))).toBeUndefined();
});

function harness(projects: readonly string[]) {
  let now = local(23, 12);
  const cruft = new Map<string, number | undefined>();
  const calls: { project: string; mode: CentralRepackMode }[] = [];
  const released: string[] = [];
  const fail = new Set<string>();
  const missing = new Set<string>();
  const stats = { packs: 9, loose: 4, size_pack_kib: 100 };
  const git: CentralMaintenanceGit = {
    projectOf: (id) =>
      ({
        project_id: id,
        source_repo: "/unused",
        base_branch: "main",
      }) as CentralProject,
    centralMaintenance: async (project) => {
      const id = project.project_id;
      if (missing.has(id)) return undefined;
      return {
        target: {
          lastCruftPack: async () => cruft.get(id),
          repack: async (mode): Promise<CentralRepackResult> => {
            calls.push({ project: id, mode });
            if (fail.has(id)) throw new Error("repack failed");
            if (mode === "cruft") cruft.set(id, now.getTime());
            return {
              mode,
              before: stats,
              after: { packs: 1, loose: 0, size_pack_kib: 40 },
              duration_ms: 12,
            };
          },
        },
        release: async () => {
          released.push(id);
        },
      };
    },
  };
  const log = vi.fn();
  const report = vi.fn();
  const executor = new CentralMaintenanceExecutor({
    store: { listProjects: () => projects.map((id) => ({ id }) as never) },
    git,
    window,
    clock: { now: () => now.toISOString() as never },
    log,
    report,
  });
  return {
    executor,
    calls,
    released,
    cruft,
    fail,
    missing,
    log,
    report,
    git,
    set: (at: Date) => {
      now = at;
    },
  };
}

test("C-637: runs only inside the window, once per occurrence, cruft when the last one is stale", async () => {
  const h = harness(["alpha", "beta"]);
  await h.executor.tick();
  expect(h.calls).toEqual([]);
  h.set(local(23, 3, 15));
  h.cruft.set("beta", local(20, 3).getTime());
  await h.executor.tick();
  expect(h.calls).toEqual([
    { project: "alpha", mode: "cruft" },
    { project: "beta", mode: "geometric" },
  ]);
  expect(h.released).toEqual(["alpha", "beta"]);
  expect(h.log).toHaveBeenCalledWith({
    event: "central_maintenance",
    project_id: "alpha",
    mode: "cruft",
    duration_ms: 12,
    repository_lock_ms: 0,
    packs_before: 9,
    packs_after: 1,
    loose_before: 4,
    loose_after: 0,
    size_pack_kib_before: 100,
    size_pack_kib_after: 40,
  });
  h.set(local(23, 5, 45));
  await h.executor.tick();
  expect(h.calls).toHaveLength(2);
  // Next night: alpha's cruft pack is one day old, beta's turned seven days.
  h.set(local(24, 3, 5));
  await h.executor.tick();
  expect(h.calls.slice(2)).toEqual([
    { project: "alpha", mode: "geometric" },
    { project: "beta", mode: "geometric" },
  ]);
  h.set(new Date(local(20, 3).getTime() + DEFAULT_CENTRAL_CRUFT_INTERVAL_MS));
  await h.executor.tick();
  expect(h.calls.slice(4)).toEqual([
    { project: "alpha", mode: "geometric" },
    { project: "beta", mode: "cruft" },
  ]);
  expect(h.report).not.toHaveBeenCalled();
});

test("C-637: a cruft run that wrote no cruft pack still counts", async () => {
  const h = harness(["alpha"]);
  const maintain = h.git.centralMaintenance;
  h.git.centralMaintenance = async (project) => {
    const held = await maintain?.(project);
    if (!held) return held;
    return {
      ...held,
      target: { ...held.target, lastCruftPack: async () => undefined },
    };
  };
  h.set(local(23, 3));
  await h.executor.tick();
  h.set(local(24, 3));
  await h.executor.tick();
  expect(h.calls.map((c) => c.mode)).toEqual(["cruft", "geometric"]);
});

test("C-637: failures are reported, released and retried within the window; absent or busy centers are skipped", async () => {
  const h = harness(["alpha", "beta"]);
  h.fail.add("alpha");
  h.missing.add("beta");
  h.set(local(23, 3));
  await h.executor.tick();
  expect(h.report).toHaveBeenCalledWith(
    "central maintenance of alpha failed: repack failed",
  );
  expect(h.released).toEqual(["alpha"]);
  expect(h.log).not.toHaveBeenCalled();
  h.fail.clear();
  h.missing.clear();
  h.set(local(23, 3, 15));
  await h.executor.tick();
  expect(h.calls.map((c) => c.project)).toEqual(["alpha", "alpha", "beta"]);
  expect(h.log).toHaveBeenCalledTimes(2);
});

test("C-637: no repack starts after the window closes mid-tick", async () => {
  const h = harness(["alpha", "beta"]);
  h.set(local(23, 5, 59));
  const repack = h.git.centralMaintenance;
  h.git.centralMaintenance = async (project) => {
    const held = await repack?.(project);
    h.set(local(23, 6, 1));
    return held;
  };
  await h.executor.tick();
  expect(h.calls.map((c) => c.project)).toEqual(["alpha"]);
});

let f: M4Fixture | undefined;
afterEach(() => {
  f?.close();
  f = undefined;
});
const run = (cwd: string, ...args: string[]) =>
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

test("C-637: ServerGit maintains only an existing center, outside the repository lock, one process at a time", async () => {
  f = m4Fixture({ project_id: "maint" });
  const source = join(f.dataDir, "source");
  run(f.dataDir, "init", "-q", "-b", "main", source);
  writeFileSync(join(source, "file"), "base");
  run(source, "add", "file");
  run(source, "commit", "-qm", "base");
  f.store.setProjectRepo({
    project_id: f.project_id,
    repo_path: source,
    base_branch: "main",
  });
  const binding = new ServerGit({ dataDir: f.dataDir, store: f.store });
  const project = binding.projectOf(f.project_id as ProjectId);
  if (!project) throw new Error("missing fixture");
  const center = join(f.dataDir, "central", `${f.project_id}.git`);
  expect(await binding.centralMaintenance(project)).toBeUndefined();
  expect(existsSync(center)).toBe(false);
  await binding.sync(project);
  for (let i = 0; i < 4; i++) {
    writeFileSync(join(source, "file"), `change ${i}`);
    run(source, "commit", "-qam", `change ${i}`);
    run(
      center,
      "-c",
      "fetch.unpackLimit=1",
      "fetch",
      "-q",
      "--no-auto-maintenance",
      source,
      `HEAD:refs/cardigan/candidates/A-1/${i}`,
    );
  }
  const held = await binding.centralMaintenance(project);
  if (!held) throw new Error("center not maintained");
  try {
    if (process.platform === "linux")
      expect(await binding.centralMaintenance(project)).toBeUndefined();
    // The repository lock stays free while maintenance holds its own lock.
    const lock = join(f.dataDir, "locks", `repo-${f.project_id}.lock`);
    if (existsSync(lock))
      execFileSync("flock", ["--exclusive", "--nonblock", lock, "true"]);
    expect(await held.target.lastCruftPack()).toBeUndefined();
    writeFileSync(join(f.dataDir, "loose"), "unreferenced");
    const unreachable = run(
      f.dataDir,
      "--git-dir",
      center,
      "hash-object",
      "-w",
      join(f.dataDir, "loose"),
    );
    const result = await held.target.repack("cruft");
    expect(result.after.packs).toBeLessThan(result.before.packs);
    expect(await held.target.lastCruftPack()).toBeGreaterThan(0);
    expect(run(center, "cat-file", "-t", unreachable)).toBe("blob");
  } finally {
    await held.release();
  }
  const again = await binding.centralMaintenance(project);
  expect(again).toBeDefined();
  await again?.release();
});
