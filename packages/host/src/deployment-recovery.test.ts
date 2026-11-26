import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Assignment, Card, Event } from "@cardigan/domain";
import { gitSafetyArguments } from "@cardigan/git-transport";
import { notificationsByRecipient, Store } from "@cardigan/store";
import { expect, test, vi } from "vitest";
import {
  DeploymentController,
  DeploymentServerUnavailable,
} from "./deployment.js";
import { deploymentInProgress } from "./deployment-capacity.js";
import { readDeploymentDiagnostics } from "./deployment-diagnostics.js";
import { NodeDeploymentDriver } from "./deployment-node.js";
import { acquireMergeCheckCapacity } from "./merge-check-capacity.js";
import { executionOwner } from "./process-identity.js";
import { acquireRepositoryFlock } from "./repository-lock.js";

const exec = promisify(execFile);
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cg-deployment-recovery-"));
  const release = join(root, "release"),
    dataDir = join(root, "data");
  await mkdir(join(release, "apps/server/dist"), { recursive: true });
  await mkdir(join(dataDir, "central"), { recursive: true });
  await chmod(release, 0o755);
  await chmod(dataDir, 0o700);
  const store = Store.open({ dataDir });
  let driver: NodeDeploymentDriver | undefined;
  let unlock: (() => Promise<void>) | undefined;
  const close = async () => {
    try {
      await driver?.stop();
    } finally {
      await unlock?.();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  };
  try {
    store.createProject({ id: "cardigan" });
    store.uow.run((tx) => {
      for (const [id, role_id] of [
        ["A-1", "pm"],
        ["A-2", "host_ops"],
      ] as const)
        tx.assignments.put("cardigan", {
          id,
          scope: "standing",
          role_id,
          standing_mode: "office",
          role_version: 1,
          status: "active",
          runtime_state: "not_provisioned",
          machine_id: "local",
          runtime_ref: null,
          mcp_token_id: "fixture",
          created_at: "2026-01-01T00:00:00.000Z",
        } as Assignment);
    });
    await writeFile(
      join(release, "apps/server/dist/bin.js"),
      `
      const net = require('node:net');
      const ports = [process.env.CARDIGAN_MCP_PORT, process.env.CARDIGAN_WEB_PORT].map(Number);
      let ready = 0;
      ports.forEach(port => net.createServer().listen(port, '127.0.0.1', () => {
        if (++ready === 2) console.log(JSON.stringify({ready:true,deployment_fence:1,
          url:'http://127.0.0.1:'+ports[0], web_url:'http://127.0.0.1:'+ports[1]}));
      }));
    `,
    );
    const git = async (args: string[]) =>
      (
        await exec(
          "git",
          [
            ...gitSafetyArguments,
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            ...args,
          ],
          {
            cwd: release,
            env: {
              PATH: process.env.PATH,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
            },
          },
        )
      ).stdout.trim();
    await git(["init", "-b", "main"]);
    await git(["add", "."]);
    await git(["commit", "-m", "test: initial server"]);
    const sha = await git(["rev-parse", "HEAD"]);
    const central = join(dataDir, "central/cardigan.git");
    await git(["clone", "--bare", release, central]);
    const mcp = await freePort();
    let web = await freePort();
    while (web === mcp) web = await freePort();
    await writeFile(join(root, "hc"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const options = {
      store,
      dataDir,
      config: {
        enabled: true,
        initial_release: release,
        initial_sha: sha,
        ready_timeout_ms: 3000,
        stop_timeout_ms: 3000,
        build_timeout_ms: 5000,
        poll_interval_ms: 1000,
      },
      env: {
        PATH: `${root}:${process.env.PATH}`,
        CARDIGAN_HC_SESSION: "synthetic-session",
        CARDIGAN_MCP_PORT: String(mcp),
        CARDIGAN_WEB_PORT: String(web),
      },
    };
    driver = new NodeDeploymentDriver(options);
    unlock = await driver.initialize();
    return {
      root,
      release,
      store,
      sha,
      git,
      central,
      close,
      get driver() {
        if (!driver) throw new Error("Fixture driver unavailable");
        return driver;
      },
      state: async () =>
        JSON.parse(
          await readFile(join(dataDir, "self-deploy/state.json"), "utf8"),
        ),
      restart: async (configure?: (driver: NodeDeploymentDriver) => void) => {
        await unlock?.();
        unlock = undefined;
        driver = new NodeDeploymentDriver(options);
        configure?.(driver);
        unlock = await driver.initialize();
      },
      records: async () => {
        const diagnostics = await readDeploymentDiagnostics(store, "cardigan");
        if (!diagnostics) throw new Error("Fixture diagnostics unavailable");
        return diagnostics.records;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

test
  .runIf(process.platform === "linux")
  .each(["before_start", "exited_candidate", "failed_recovery"])(
  "interrupted %s recovery retains the audited candidate and real backup",
  async (scenario) => {
    const f = await fixture();
    try {
      const oldProcess = (await f.state()).process;
      const to = "b".repeat(40);
      const stopped = await f.driver.beforeStop({
        attempt: "interrupted-backup",
        from: f.sha,
        to,
        status: "started",
        build: "passed",
        ready: false,
        downtime_ms: 0,
        summary: "准备切换",
      });
      await f.driver.stop();
      const backup = await f.driver.backup();
      expect(
        (await lstat(join(f.root, "data/self-deploy", backup))).isFile(),
      ).toBe(true);
      if (scenario === "exited_candidate") {
        expect(executionOwner(oldProcess.pid)).toBeUndefined();
        await writeFile(
          join(f.root, "data/self-deploy/state.json"),
          JSON.stringify({
            ...(await f.state()),
            running: { sha: to, release: f.release },
            process: oldProcess,
            ready: false,
          }),
          { mode: 0o600 },
        );
      }
      if (scenario === "failed_recovery") {
        await expect(
          f.restart((d) => vi.spyOn(d, "ready").mockResolvedValue(false)),
        ).rejects.toThrow("Initial server did not become ready");
        expect((await f.records())[0]).toMatchObject({
          status: "failed",
          from: f.sha,
          to,
          backup_file: backup,
        });
      }
      await f.restart();
      const recovered = await f.state();
      expect(recovered.current.sha).toBe(f.sha);
      expect(recovered.ready).toBe(true);
      expect(recovered.backup_file).toBeUndefined();
      expect((await f.records())[0]).toMatchObject({
        attempt: stopped.attempt,
        from: f.sha,
        to,
        status: "rolled_back",
        ready: true,
        backup_file: backup,
        stop_snapshot: stopped.stop_snapshot,
      });
      const actions = f.store.uow.read((tx) =>
        tx.human_actions.list("cardigan"),
      );
      expect(actions).toHaveLength(1);
      expect(actions[0]?.instructions).toContain(backup);
      expect(JSON.stringify([actions, await f.records()])).not.toContain(
        f.root,
      );
      // A completed recovery is not another interrupted switch on normal restart.
      const count = (await f.records()).length;
      await f.driver.stop();
      await f.restart();
      expect(await f.records()).toHaveLength(count);
    } finally {
      await f.close();
    }
  },
  15000,
);

test.runIf(process.platform === "linux")(
  "a dead persisted candidate remains attributable without an earlier stop audit",
  async () => {
    const f = await fixture();
    try {
      const oldProcess = (await f.state()).process;
      await f.driver.stop();
      const backup = await f.driver.backup();
      await writeFile(
        join(f.root, "data/self-deploy/state.json"),
        JSON.stringify({
          ...(await f.state()),
          running: { sha: "b".repeat(40), release: f.release },
          process: oldProcess,
          ready: false,
        }),
        { mode: 0o600 },
      );
      await f.restart();
      expect((await f.records())[0]).toMatchObject({
        status: "rolled_back",
        from: f.sha,
        to: "b".repeat(40),
        backup_file: backup,
      });
    } finally {
      await f.close();
    }
  },
  15000,
);

test
  .runIf(process.platform === "linux")
  .each(["initial", "recovery", "log_cleanup"])(
  "%s startup reports audit loss safely and releases both supervisor locks",
  async (scenario) => {
    const f = await fixture();
    try {
      if (scenario === "recovery") {
        await f.driver.beforeStop({
          attempt: "audit-loss",
          from: f.sha,
          to: "b".repeat(40),
          status: "started",
          build: "passed",
          ready: false,
          downtime_ms: 0,
          summary: "准备切换",
        });
      }
      await f.driver.stop();
      if (scenario === "recovery") await f.driver.backup();
      else await rm(join(f.root, "data/self-deploy/state.json"));
      const before = (await f.records()).length;
      const failure = await f
        .restart((d) => {
          vi.spyOn(d, "ready").mockResolvedValue(false);
          vi.spyOn(d, "record").mockRejectedValue(
            new Error("Authorization: Bearer synthetic-audit-secret"),
          );
          if (scenario === "log_cleanup")
            vi.spyOn(d, "finishServerLogs").mockRejectedValue(
              new Error("TOKEN=synthetic-log-secret"),
            );
        })
        .then(
          () => {
            throw new Error("Expected initialization failure");
          },
          (error) => error,
        );
      expect(failure.message).toContain("startup_ready_failed");
      expect(failure.message).toContain("ready: not_exited");
      expect(failure.message).toContain(
        "deployment_audit_failed：部署失败审计未保存",
      );
      if (scenario === "log_cleanup")
        expect(failure.message).toContain("deployment_log_cleanup_failed");
      expect(failure.message).not.toMatch(/synthetic|Authorization|TOKEN=/);
      expect((await f.state()).process).toBeUndefined();
      expect(deploymentInProgress(f.store)).toBe(false);
      const unlock = await acquireRepositoryFlock(
        join(f.root, "data/self-deploy/supervisor.lock"),
        1,
      );
      await unlock();
      expect(await f.records()).toHaveLength(before);
      // The failed audit did not commit a partial event or human action.
      expect(
        f.store.uow.read((tx) => tx.human_actions.list("cardigan")),
      ).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
  15000,
);

test.runIf(process.platform === "linux").each([false, true])(
  "ready server exit is fatal, audited and recoverable even without new main (adopted=%s)",
  async (adopted) => {
    const f = await fixture();
    await expect(
      lstat(join(f.root, "data/self-deploy/logs")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    let releaseCheck: (() => void) | undefined;
    try {
      if (adopted) await f.restart();
      const before = await f.state();
      expect(before.ready).toBe(true);
      releaseCheck = acquireMergeCheckCapacity(
        f.store,
        "cardigan",
        "busy-check",
      );
      expect(releaseCheck).toBeDefined();
      // Only this fixture's child is signalled; emulate a ready process crash.
      process.kill(before.process.pid, "SIGKILL");
      await vi.waitFor(() =>
        expect(executionOwner(before.process.pid)).toBeUndefined(),
      );
      const c = new DeploymentController(f.driver);
      await expect(c.tick()).rejects.toBeInstanceOf(
        DeploymentServerUnavailable,
      );
      await expect(c.tick()).rejects.toBeInstanceOf(
        DeploymentServerUnavailable,
      );
      const stopped = await f.state();
      expect(stopped.ready).toBe(false);
      expect(stopped.process).toBeUndefined();
      expect(stopped.current.sha).toBe(f.sha);
      const records = await f.records();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        from: f.sha,
        to: f.sha,
        status: "failed",
        ready: false,
        build: "not_run",
      });
      expect(records[0]?.summary).toContain("server_exited");
      expect(JSON.stringify(records)).not.toContain(f.root);
      for (const id of ["A-1", "A-2"])
        expect(
          notificationsByRecipient(f.store.database, "cardigan").get(
            `assignment:${id}`,
          ),
        ).toHaveLength(1);
      expect(
        f.store.uow.read((tx) => tx.human_actions.list("cardigan")),
      ).toHaveLength(1);
      releaseCheck?.();
      releaseCheck = undefined;
      // Model the host service manager restarting watch, using persisted current.
      await f.restart();
      const recovered = await f.state();
      expect(recovered.ready).toBe(true);
      expect(recovered.current.sha).toBe(f.sha);
      expect(recovered.process).not.toEqual(before.process);
      await new DeploymentController(f.driver).tick();
      expect(await f.records()).toHaveLength(1);
    } finally {
      releaseCheck?.();
      await f.close();
    }
  },
  15000,
);

test.runIf(process.platform === "linux")(
  "main publication before card_merged is retried after matching evidence arrives",
  async () => {
    const f = await fixture();
    try {
      const originalProcess = (await f.state()).process;
      await f.git(["commit", "--allow-empty", "-m", "test: merged change"]);
      const to = await f.git(["rev-parse", "HEAD"]);
      const tree = await f.git(["rev-parse", "HEAD^{tree}"]);
      const card: Card = {
        id: "C-1" as Card["id"],
        project_id: "cardigan",
        title: "Fixture",
        goal: "Fixture",
        acceptance_criteria: [],
        source: { kind: "quote", text: "Fixture" },
        out_of_scope: [],
        related_cards: [],
        priority: 1,
        status: "done",
        template: "dev",
        merge_policy: "confirm",
        created_by: "human",
        created_at: "2026-01-01T00:00:00.000Z",
      };
      const append = (type: string, payload: Event["payload"]) =>
        f.store.uow.run((tx) => {
          tx.cards.put("cardigan", card);
          tx.events.append("cardigan", {
            id: tx.ids.nextEventId(),
            card_id: card.id,
            seq: tx.ids.nextEventSequence("cardigan", card.id),
            type,
            payload,
            actor: { kind: "system", project_id: "cardigan" },
            created_at: card.created_at,
          });
        });
      append("merge_check_finished", {
        completion_id: "D-1",
        tree_sha: tree,
        status: "passed",
      });
      await f.git(["--git-dir", f.central, "fetch", f.release, "main"]);
      await f.git([
        "--git-dir",
        f.central,
        "update-ref",
        "refs/heads/main",
        to,
        f.sha,
      ]);
      const build = vi.spyOn(f.driver, "build").mockResolvedValue({
        build: { sha: to, release: f.release },
        log_tail: "fixture",
      });
      vi.spyOn(f.driver, "refreshRoles").mockResolvedValue();
      const c = new DeploymentController(f.driver);
      await c.tick();
      await c.tick();
      expect(build).not.toHaveBeenCalled();
      expect((await f.state()).process).toEqual(originalProcess);
      expect(await f.records()).toHaveLength(1);
      expect((await f.records())[0]?.status).toBe("waiting_for_evidence");
      expect(
        f.store.uow.read((tx) => tx.human_actions.list("cardigan")),
      ).toHaveLength(0);
      for (const id of ["A-1", "A-2"])
        expect(
          notificationsByRecipient(f.store.database, "cardigan").get(
            `assignment:${id}`,
          ),
        ).toHaveLength(1);
      append("card_merged", {
        completion_id: "D-1",
        result: {
          kind: "merged",
          previous_sha: f.sha,
          merge_sha: to,
          tree_sha: tree,
        },
      });
      expect(await f.driver.passedMergeGate(f.sha, to)).toBe(true);
      await c.tick();
      await c.tick();
      expect(build).toHaveBeenCalledOnce();
      expect((await f.state()).current.sha).toBe(to);
      const records = await f.records();
      expect(records[0]).toMatchObject({ status: "deployed", to, ready: true });
      expect(records.some((record) => record.status === "failed")).toBe(false);
    } finally {
      await f.close();
    }
  },
  15000,
);

test.runIf(process.platform === "linux")(
  "C-787: a restarted supervisor starts the build handed over with the stopped server, once, and only when addressed to it",
  async () => {
    const f = await fixture();
    try {
      // The next main and its built release, as the old supervisor's deployment made them.
      const work = join(f.root, "work");
      await f.git(["clone", "-q", f.central, work]);
      await f.git(["-C", work, "commit", "--allow-empty", "-m", "test: next"]);
      const next = await f.git(["-C", work, "rev-parse", "HEAD"]);
      await f.git(["-C", work, "push", "-q", "origin", "HEAD:main"]);
      await writeFile(join(f.root, "pnpm"), "#!/bin/sh\nexit 0\n", {
        mode: 0o700,
      });
      const built = (await f.driver.build(next)).build;
      if (!built) throw new Error("fixture build failed");
      const directory = join(f.root, "data/self-deploy");
      const root = await realpath(
        fileURLToPath(new URL("../../../", import.meta.url)),
      );
      // The old supervisor's switch: stop record, stopped server, restart plan.
      const handOver = async (attempt: string, newRoot: string) => {
        await f.driver.beforeStop({
          attempt,
          from: f.sha,
          to: next,
          status: "started",
          build: "passed",
          ready: false,
          downtime_ms: 0,
          summary: "构建已完成",
        });
        await f.driver.stop();
        const plan = {
          version: 1,
          attempt: "00000000-0000-4000-8000-0000000000aa",
          from: "c".repeat(40),
          to: next,
          unit: "cardigan-selfdeploy.service",
          launch_file: join(f.root, "unit.service"),
          launch_mode: 0o600,
          launch_sha256: "0".repeat(64),
          backup_file: join(directory, "supervisor-launch-x.bak"),
          old_root: join(dirname(newRoot), "release-watch-old"),
          new_root: newRoot,
          health_timeout_ms: 60_000,
          ports: [{ host: "127.0.0.1", port: 1 }],
          supervisor: { pid: 1, start: "old-supervisor" },
          requested_at: new Date().toISOString(),
          deploy: {
            attempt,
            sha: next,
            release: built.release,
            from: f.sha,
            stopped_at: Date.now() - 1_000,
          },
        };
        await writeFile(
          join(directory, "supervisor-upgrade.json"),
          JSON.stringify(plan),
          { mode: 0o600 },
        );
      };
      // Addressed to another checkout: ordinary recovery of the old build.
      await handOver(
        "00000000-0000-4000-8000-000000000001",
        join(dirname(root), "release-watch-other"),
      );
      await f.restart();
      expect(f.driver.takeHandoff()).toBeUndefined();
      expect((await f.state()).current.sha).toBe(f.sha);
      expect((await f.records())[0]).toMatchObject({
        attempt: "00000000-0000-4000-8000-000000000001",
        status: "rolled_back",
      });
      // Addressed to this checkout: startup leaves the server stopped and
      // keeps the capacity for the controller, which starts `next` first.
      await handOver("00000000-0000-4000-8000-000000000002", root);
      await f.restart();
      expect((await f.state()).process).toBeUndefined();
      expect(f.store.uow.read(() => deploymentInProgress(f.store))).toBe(true);
      vi.spyOn(f.driver, "refreshRoles").mockResolvedValue();
      await new DeploymentController(f.driver).tick();
      const state = await f.state();
      expect(state).toMatchObject({
        current: { sha: next, release: built.release },
        previous: { sha: f.sha },
        ready: true,
      });
      expect(executionOwner(state.process.pid)?.start).toBe(
        state.process.start,
      );
      expect((await f.records())[0]).toMatchObject({
        attempt: "00000000-0000-4000-8000-000000000002",
        from: f.sha,
        to: next,
        status: "deployed",
        ready: true,
        summary: expect.stringContaining("与监督器升级合并为一次停起"),
      });
      expect(f.store.uow.read(() => deploymentInProgress(f.store))).toBe(false);
      // Consumed: a later restart with the plan still present starts `next`
      // normally and replays nothing.
      const count = (await f.records()).length;
      await f.driver.stop();
      await f.restart();
      expect(f.driver.takeHandoff()).toBeUndefined();
      expect((await f.state()).current.sha).toBe(next);
      expect(await f.records()).toHaveLength(count);
    } finally {
      await f.close();
    }
  },
  30000,
);
