import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import { NodeDeploymentDriver } from "./deployment-node.js";
import {
  DeploymentRetention,
  RETENTION_ROUND,
} from "./deployment-retention.js";
import { parseRetention } from "./deployment-retention-policy.js";

const release = (n: number) =>
  `release-${String(n).padStart(40, "0")}-00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const backup = (n: number) =>
  `database-00000000-0000-4000-8000-${String(n).padStart(12, "0")}.bak`;
const DAY = 86_400_000;
const now = Date.parse("2026-11-25T12:00:00Z");

async function site(project = "cardigan") {
  const tmp = await mkdtemp(join(tmpdir(), "cg-retention-"));
  const dir = join(tmp, "self-deploy");
  const store = Store.open({ dataDir: tmp, dbPath: ":memory:" });
  store.createProject({ id: project });
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
  const outside = join(tmp, "outside");
  await writeFile(outside, "keep me");
  for (let n = 1; n <= 13; n++) {
    const path = join(dir, release(n));
    await mkdir(join(path, "node_modules/pkg"), { recursive: true });
    await writeFile(join(path, "node_modules/pkg/index.js"), "x".repeat(5000));
    await symlink(outside, join(path, "link"));
    // A read-only cache directory must not stop removal.
    await chmod(join(path, "node_modules/pkg"), 0o500);
    await chmod(path, 0o700);
    const t = new Date(now - (20 - n) * DAY);
    await utimes(path, t, t);
  }
  for (const [n, age] of [
    [1, 30],
    [2, 20],
    [3, 10],
    [4, 9],
    [5, 2],
    [6, 1],
  ] as const) {
    const path = join(dir, backup(n));
    await writeFile(path, "db", { mode: 0o600 });
    const t = new Date(now - age * DAY);
    await utimes(path, t, t);
  }
  await mkdir(join(dir, "backups"));
  await writeFile(join(dir, "backups", backup(9)), "manual", { mode: 0o600 });
  const ready = {
    stillReady: async () => true,
    // state.json still references the oldest release (previous) and backup 1.
    keep: [join(dir, release(13)), join(dir, release(1), "apps")],
    backup: backup(1),
    attempt: "deployed-1",
    deployed_at: new Date(now).toISOString(),
  };
  const rounds = () =>
    store.uow.read((tx) =>
      tx.events
        .listAfter(project, undefined, 0)
        .filter((e) => e.type === RETENTION_ROUND),
    );
  return {
    tmp,
    dir,
    store,
    outside,
    ready,
    rounds,
    close: async () => {
      store.close();
      execFileSync("chmod", ["-R", "u+rwx", tmp]);
      await rm(tmp, { recursive: true, force: true });
    },
  };
}

test("C-743: a successful deployment prunes releases beyond 10 and old backups, keeping every referenced one", async () => {
  const s = await site();
  try {
    const retention = new DeploymentRetention(
      s.store,
      s.dir,
      parseRetention({}),
      () => now,
    );
    for (let i = 0; i < 20; i++) await retention.poll(s.ready);
    const left = (await readdir(s.dir)).sort();
    // Releases 4..13 are the newest ten; 1 stays because state.json uses it.
    expect(left.filter((n) => n.startsWith("release-"))).toEqual(
      [1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map(release).sort(),
    );
    // Within 7 days: 5, 6; the newest three: 4, 5, 6; 1 is the recovery reference.
    expect(left.filter((n) => n.startsWith("database-"))).toEqual(
      [1, 4, 5, 6].map(backup),
    );
    expect(left).toContain("backups");
    expect(await readFile(join(s.dir, "backups", backup(9)), "utf8")).toBe(
      "manual",
    );
    expect(await readFile(s.outside, "utf8")).toBe("keep me");
    const rounds = s.rounds();
    expect(rounds).toHaveLength(1);
    const p = rounds[0]?.payload as Record<string, unknown> & {
      releases: { removed: number; freed_bytes: number };
      snapshots: { removed: number; freed_bytes: number };
    };
    expect(p).toMatchObject({
      scope: "deployment",
      mode: "auto",
      attempt: "deployed-1",
      removed: 4,
      releases: { removed: 2 },
      snapshots: { removed: 2, freed_bytes: 4 },
      failed: [],
    });
    expect(p.releases.freed_bytes).toBeGreaterThan(5000);
    expect(p.freed_bytes).toBe(
      p.releases.freed_bytes + p.snapshots.freed_bytes,
    );
    expect(p.names).toEqual(
      expect.arrayContaining([release(2), release(3), backup(2), backup(3)]),
    );
    // Once per deployment: the same attempt does nothing more.
    await retention.poll(s.ready);
    expect(s.rounds()).toHaveLength(1);
  } finally {
    await s.close();
  }
});

test("C-743: preview mode records the same round and removes nothing; a changed deployment stops the round", async () => {
  const s = await site();
  try {
    const before = (await readdir(s.dir)).sort();
    const preview = new DeploymentRetention(
      s.store,
      s.dir,
      parseRetention({ mode: "preview" }),
      () => now,
    );
    for (let i = 0; i < 20; i++) await preview.poll(s.ready);
    expect((await readdir(s.dir)).sort()).toEqual(before);
    expect(s.rounds()[0]?.payload).toMatchObject({
      mode: "preview",
      removed: 4,
      releases: { removed: 2 },
    });
    const auto = new DeploymentRetention(
      s.store,
      s.dir,
      parseRetention({}),
      () => now,
    );
    await auto.poll({ ...s.ready, stillReady: async () => false });
    await auto.poll({ ...s.ready, stillReady: async () => false });
    expect((await readdir(s.dir)).sort()).toEqual(before);
    expect(s.rounds()).toHaveLength(1);
  } finally {
    await s.close();
  }
});

test("supervisor never starts retention on rollback, pre-ready, dead server, or mismatched running build", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "cg-retention-ready-")),
    project = "cardigan";
  const store = Store.open({ dataDir: tmp, dbPath: ":memory:" });
  try {
    store.createProject({ id: project });
    const current = { release: tmp, sha: "a".repeat(40) };
    const driver = new NodeDeploymentDriver({
      store,
      dataDir: tmp,
      env: {},
      config: {
        enabled: true,
        initial_release: tmp,
        initial_sha: current.sha,
        ready_timeout_ms: 1000,
        stop_timeout_ms: 1000,
        poll_interval_ms: 1000,
        build_timeout_ms: 1000,
        retention: parseRetention({}),
      },
    });
    const state = { current, running: current, ready: true, fence: 1 };
    const inside = driver as unknown as {
      state: typeof state;
      readState: () => Promise<typeof state>;
      live: () => boolean;
      retention: DeploymentRetention;
    };
    inside.state = state;
    const diskState = vi.spyOn(inside, "readState").mockResolvedValue(state);
    const live = vi.spyOn(inside, "live").mockReturnValue(true);
    const poll = vi.spyOn(inside.retention, "poll").mockResolvedValue();
    const record = (status: string) =>
      store.uow.run((tx) =>
        tx.events.append(project, {
          id: tx.ids.nextEventId(),
          seq: tx.ids.nextEventSequence(project),
          actor: { kind: "system", project_id: project },
          type: "host_deployment_recorded",
          created_at: new Date().toISOString(),
          payload: { to: current.sha, attempt: "fixture", status, ready: true },
        }),
      );
    await driver.maintainDisk();
    record("rolled_back");
    await driver.maintainDisk();
    record("deployed");
    diskState.mockResolvedValueOnce({ ...state, ready: false });
    await driver.maintainDisk();
    diskState.mockResolvedValueOnce({
      ...state,
      running: { ...current, release: "/not-current" },
    });
    await driver.maintainDisk();
    live.mockReturnValueOnce(false);
    await driver.maintainDisk();
    expect(poll).not.toHaveBeenCalled();
    await driver.maintainDisk();
    expect(poll).toHaveBeenCalledOnce();
    diskState.mockResolvedValueOnce({ ...state, ready: false });
    expect(await poll.mock.calls[0]?.[0].stillReady()).toBe(false);
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
