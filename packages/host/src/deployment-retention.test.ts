import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Attachment, Decision } from "@cardigan/domain";
import { Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import {
  assignment,
  card,
  id,
} from "../../domain/src/commands/test-fixtures.js";
import { NodeDeploymentDriver } from "./deployment-node.js";
import { DeploymentRetention } from "./deployment-retention.js";
import { parseRetention } from "./deployment-retention-policy.js";

test("frozen site inventory, two bound approvals, fresh run checks and audited nonrecursive cleanup", async () => {
  const p = "cardigan",
    tmp = await mkdtemp(join(tmpdir(), "cg-retention-")),
    dir = join(tmp, "self-deploy"),
    root = join(tmp, "agent"),
    parent = join(root, "runs", p);
  const store = Store.open({ dataDir: tmp, dbPath: ":memory:" });
  try {
    await mkdir(dir, { mode: 0o700 });
    await mkdir(parent, { recursive: true });
    for (const path of [root, join(root, "runs"), parent])
      await chmod(path, 0o2750);
    for (const n of [1, 2]) {
      const path = join(parent, `A-${n}`);
      await mkdir(path);
      await chmod(path, 0o2770);
      await writeFile(join(path, "cache"), "cache");
    }
    const cmd = (op: string) => ({
      file: "/usr/bin/python3",
      args: [
        "-I",
        "-B",
        "-c",
        `import os,sys,runpy,json\nfrom unittest.mock import patch\nm=runpy.run_path(sys.argv[1]); uid=os.getuid()\nwith patch('os.getuid',return_value=uid+10001): print(json.dumps(m['main'](sys.argv[2],json.load(sys.stdin))))`,
        fileURLToPath(new URL("./deployment-retention-fs.py", import.meta.url)),
        op,
      ],
    });
    let interruptClear = false;
    const target = async () => ({
      ownsRef: (ref: { runtime_machine: string } | null | undefined) =>
        ref?.runtime_machine === "fixture",
      root,
      gid: process.getgid?.() ?? -1,
      fingerprint: "test-only",
      inventory: cmd("inventory"),
      clear: interruptClear
        ? {
            file: "/usr/bin/python3",
            args: [
              "-I",
              "-B",
              "-c",
              `import os,json,sys
r=json.load(sys.stdin); assert r['names']==['A-4']; os.unlink(os.path.join(r['root'],'runs','cardigan','A-4','partial'));sys.exit(1)`,
            ],
          }
        : cmd("clear"),
    });
    const policy = parseRetention({ snapshots: 1, daily_days: 1 });
    const backup = (n: number) =>
      `database-00000000-0000-4000-8000-${String(n).padStart(12, "0")}.bak`;
    for (const n of [1, 2]) {
      const path = join(dir, backup(n));
      await writeFile(path, "db", { mode: 0o600 });
      await utimes(path, n, n);
    }
    await writeFile(join(dir, backup(3)), "unverified", { mode: 0o640 });
    await chmod(join(dir, backup(3)), 0o640);
    await utimes(join(dir, backup(3)), 0, 0);
    const ready = {
      stillReady: async () => true,
      keep: [dir],
      attempt: "deployed",
      deployed_at: new Date().toISOString(),
    };
    store.createProject({ id: p });
    store.uow.run((tx) => {
      tx.cards.put(p, { ...card(), project_id: p });
      for (const n of [1, 2])
        tx.assignments.put(p, {
          ...assignment(n),
          runtime_ref: {
            machine_id: "local",
            runtime_machine: "fixture",
            agent_name: "fixture",
            terminal_ref: "fixture/t1",
          },
          status: "released",
          released_at: "2026-01-01T00:00:00Z",
        });
      tx.assignments.put(p, assignment(3, "pm"));
    });
    const maintenance = (q = policy) =>
      new DeploymentRetention(store, dir, {}, q, target);
    const releaseName = `release-${"c".repeat(40)}-00000000-0000-4000-8000-000000000001`;
    await mkdir(join(dir, releaseName), { mode: 0o700 });
    await writeFile(join(dir, releaseName, "server"), "never remove");
    const at = Date.now() - 10 * 86400000;
    const survey = maintenance();
    await vi.waitFor(async () => {
      await survey.poll(ready, at);
      await readFile(join(dir, "retention-preview-1.json"));
    });
    const path = join(dir, "retention-preview-1.json"),
      text = await readFile(path, "utf8"),
      sha = createHash("sha256").update(text).digest("hex");
    expect(
      JSON.parse(text)
        .candidates.map((i: { name: string }) => i.name)
        .sort(),
    ).toEqual(["A-1", "A-2", backup(1)]);
    const report = JSON.parse(text);
    expect(report.retained_releases).toEqual([
      { name: releaseName, reason: "recent", size_bytes: expect.any(Number) },
    ]);
    expect(report.total_bytes).toBe(
      report.candidates.reduce(
        (n: number, i: { size_bytes: number }) => n + i.size_bytes,
        0,
      ),
    );
    expect(JSON.parse(text).skipped).toContain(backup(3));
    await chmod(join(dir, backup(3)), 0o600);
    const auth = { sha256: sha, pm_review: "Q-1", data_deletion: "Q-2" };
    const apply = () => maintenance({ ...policy, approval: auth });
    const check = async () => {
      expect(await readFile(join(dir, backup(1)), "utf8")).toBe("db");
      expect(await readFile(path, "utf8")).toBe(text);
    };
    await apply().poll(ready);
    await check();
    const q = (n: number, option: string) =>
      ({
        id: id("decision", n),
        kind: "approve",
        category: n === 1 ? "permission" : "data_deletion",
        card_id: card().id,
        status: "resolved",
        target: { subject: { kind: "artifact_sha256", value: sha } },
        attachment_ids: ["evidence"],
        resolution: {
          resolved_by: n === 1 ? "assignment:A-3" : "human",
          option,
          at: new Date().toISOString(),
        },
      }) as Decision;
    store.uow.run((tx) => {
      tx.attachments.put(p, {
        id: "evidence",
        kind: "evidence",
        card_id: card().id,
        sha256: sha,
        size: text.length,
        storage_path: "fixture",
      } as Attachment);
      tx.decisions.put(p, q(1, "enable_retention"));
      tx.decisions.put(p, q(2, "reject"));
    });
    await apply().poll(ready);
    await check();
    store.uow.run((tx) => tx.decisions.put(p, q(2, "enable_retention")));
    const job = apply();
    await job.poll(ready);
    await expect(readFile(join(dir, backup(1)))).rejects.toMatchObject({
      code: "ENOENT",
    });
    // Candidate was queued while released, but is no longer eligible at the deletion boundary.
    store.uow.run((tx) => tx.assignments.put(p, assignment(1)));
    await job.poll(ready);
    await job.poll(ready);
    expect(await readFile(join(parent, "A-1", "cache"), "utf8")).toBe("cache");
    await expect(readFile(join(parent, "A-2", "cache"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(parent, "A-2"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const later = {
      ...ready,
      attempt: "later",
      deployed_at: new Date(Date.now() + 10_000).toISOString(),
    };
    const added = join(parent, "A-4");
    await mkdir(added);
    await chmod(added, 0o2770);
    await writeFile(join(added, "partial"), "partial");
    await writeFile(join(added, "left"), "retained");
    store.uow.run((tx) =>
      tx.assignments.put(p, {
        ...assignment(4),
        runtime_ref: {
          machine_id: "local",
          runtime_machine: "fixture",
          terminal_ref: "fixture/t4",
          agent_name: "fixture",
        },
        status: "released",
        released_at: new Date(at + 86400000).toISOString(),
      }),
    );
    interruptClear = true;
    await job.poll(later);
    await expect(readFile(join(added, "partial"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    interruptClear = false;
    await apply().poll(later); // restarted supervisor sees durable intent; changed tree is never retried
    expect(await readFile(join(added, "left"), "utf8")).toBe("retained");
    expect(await readFile(join(dir, releaseName, "server"), "utf8")).toBe(
      "never remove",
    );
    expect(await readFile(join(dir, backup(3)), "utf8")).toBe("unverified");
    expect(await readFile(join(dir, backup(2)), "utf8")).toBe("db");
    expect(
      store.uow
        .read((tx) => tx.events.listAfter(p, undefined, 0))
        .filter((e) => e.type === "host_retention_recorded")
        .map((e) => e.payload),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "A-1", status: "retained" }),
        expect.objectContaining({ name: "A-2", status: "removed" }),
        expect.objectContaining({
          name: backup(1),
          status: "removed",
          size_bytes: 2,
        }),
      ]),
    );
  } finally {
    store.close();
    await rm(tmp, { recursive: true, force: true });
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
